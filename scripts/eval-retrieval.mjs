#!/usr/bin/env node
// Phase 8 retrieval-quality eval harness — `pnpm eval`.
//
// Runs the golden Q&A set (evals/golden.json) through the REAL retrieval
// stack — the real chunker (`chunkDocument` from @kb/rag-core), the real
// embedding model (`createAi()` from @kb/ai, respecting AI_EMBEDDING_PROVIDER
// — keyless/deterministic `mock` by default, so this needs no API key and
// costs nothing to run), and the real `replace_document_chunks` /
// `match_document_chunks` Postgres RPCs — rather than reimplementing any
// retrieval or ranking math in JS. Reusing the same Docker-free ephemeral
// Postgres pattern as apps/api/test/e2e and apps/web/e2e (bootstrap.sql +
// the real supabase/migrations/*.sql, via `psql`, no `pg` npm client — see
// those directories' global-setup.ts), just without PostgREST/HTTP in front
// of it: this harness calls the RPCs directly over a `psql` session acting
// as one seeded, RLS-scoped `authenticated` user, the same
// set_config('request.jwt.claims', ...) + `set role authenticated` pattern
// supabase/tests/*.test.sql uses.
//
// Prints hit@1 / hit@3 / hit@8 / MRR for each of several configs — hybrid
// vs. vector-only, three chunk-size presets, and with/without the heading
// breadcrumb in the embedding input — computed against a fresh ephemeral
// database per config so configs never contaminate each other. See
// docs/DECISIONS.md Phase 8, D8.1 for the full write-up and a run's actual
// output.

import { readFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { chunkDocument } from "@kb/rag-core";
import { createAi } from "@kb/ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SUPERUSER_URL = process.env.E2E_POSTGRES_SUPERUSER_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const EVAL_DB = process.env.EVAL_DB_NAME ?? "kb_eval";
const MATCH_COUNT = 8;
// Deliberately no similarity floor: production defaults RAG_MIN_SIMILARITY
// to 0.25 to keep weak semantic-only matches out of a real chat answer, but
// that's a product decision about what to show a user, not a measure of
// ranking quality — flooring it here would hide exactly the ranking
// differences between configs this harness exists to compare. See D8.1.
const MIN_SIMILARITY = -1;

// ---------------------------------------------------------------------------
// psql plumbing — same spawnSync-a-real-psql approach as
// apps/api/test/e2e/global-setup.ts, deliberately not a JS Postgres client
// (no e2e harness in this repo uses one; see that file's own docstring).
// ---------------------------------------------------------------------------

function dbUrl(name) {
  const u = new URL(SUPERUSER_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

function psql(url, args) {
  const result = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8" });
  if (result.error) {
    throw new Error(
      `Could not run psql (${result.error.message}). This harness needs a local Postgres reachable via ` +
        `E2E_POSTGRES_SUPERUSER_URL (defaults to postgres/postgres@127.0.0.1:5432) with the pgvector extension ` +
        `installable — the same Postgres the Gate 3/Gate 6 e2e suites use. See docs/DECISIONS.md Phase 3, D3.1.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`psql exited ${result.status}:\n${result.stderr}`);
  }
  return result.stdout;
}

function psqlFile(url, filePath) {
  return psql(url, ["-q", "-f", filePath]);
}

async function bootstrapDb(name) {
  psql(SUPERUSER_URL, ["-q", "-c", `drop database if exists ${name};`]);
  psql(SUPERUSER_URL, ["-q", "-c", `create database ${name};`]);
  psqlFile(dbUrl(name), path.join(ROOT, "apps", "api", "test", "e2e", "bootstrap.sql"));
  const migrationsDir = path.join(ROOT, "supabase", "migrations");
  const migrations = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const migration of migrations) {
    psqlFile(dbUrl(name), path.join(migrationsDir, migration));
  }
}

function dropDb(name) {
  try {
    psql(SUPERUSER_URL, ["-q", "-c", `drop database if exists ${name};`]);
  } catch (error) {
    console.warn(`  (cleanup) failed to drop ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A dollar-quote tag unlikely enough to collide with real corpus text that
 * this repo's other SQL-generation code (supabase/tests/*.test.sql) treats
 * the same assumption as fine for hand-written literals — used here for
 * machine-generated ones. */
function dollarTag() {
  return `q${crypto.randomBytes(6).toString("hex")}`;
}

function dq(tag, text) {
  return `$${tag}$${text}$${tag}$`;
}

function pgVectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

// ---------------------------------------------------------------------------
// Corpus loading + per-config indexing
// ---------------------------------------------------------------------------

async function loadGolden() {
  const raw = await readFile(path.join(ROOT, "evals", "golden.json"), "utf8");
  return JSON.parse(raw);
}

/** Chunks + embeds every document under `config`, then writes them into a
 * fresh ephemeral database as one seeded, RLS-scoped user — mirroring
 * indexing.service.ts's own chunk -> embed -> replace_document_chunks flow,
 * just driven directly instead of through the queue/HTTP layer. */
async function indexCorpus({ dbName, documents, config, ai }) {
  const tag = dollarTag();
  const userId = crypto.randomUUID();
  const statements = [];

  statements.push(`insert into auth.users (id, email) values ('${userId}', 'eval@example.com');`);
  statements.push(
    `select set_config('request.jwt.claims', ${dq(
      tag,
      JSON.stringify({ sub: userId, role: "authenticated" }),
    )}, false);`,
  );
  statements.push(`set role authenticated;`);

  for (const doc of documents) {
    const contentHash = crypto.createHash("sha256").update(doc.title).update("\0").update(doc.content).digest("hex");
    const chunks = chunkDocument(doc.title, doc.content, config.chunkOptions);
    if (chunks.length === 0) continue;

    const inputs = chunks.map((chunk) =>
      config.breadcrumb ? `${chunk.headingPath ?? ""}\n\n${chunk.content}`.trim() : chunk.content,
    );
    const { vectors } = await ai.embeddings.embed(inputs);

    const documentId = crypto.randomUUID();
    const tagsArray = `array[${doc.tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")}]::text[]`;

    statements.push(
      `insert into public.documents (id, title, content, content_hash, tags, index_status) values (` +
        `'${documentId}', ${dq(tag, doc.title)}, ${dq(tag, doc.content)}, '${contentHash}', ${tagsArray}, 'ready');`,
    );

    const rpcChunks = chunks.map((chunk, i) => ({
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
      heading_path: chunk.headingPath,
      token_count: chunk.tokenCount,
      char_start: chunk.charStart,
      char_end: chunk.charEnd,
      embedding: pgVectorLiteral(vectors[i] ?? []),
    }));

    statements.push(
      `select public.replace_document_chunks('${documentId}', '${contentHash}', ${dq(
        tag,
        ai.embeddings.descriptor.model,
      )}, ${dq(tag, JSON.stringify(rpcChunks))}::jsonb);`,
    );
  }

  const scriptDir = await mkdtemp(path.join(os.tmpdir(), "kb-eval-"));
  const scriptPath = path.join(scriptDir, "index.sql");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(scriptPath, statements.join("\n\n")));
  try {
    psqlFile(dbUrl(dbName), scriptPath);
  } finally {
    await rm(scriptDir, { recursive: true, force: true });
  }

  return { userId };
}

/**
 * Runs every golden query against `match_document_chunks` as the seeded
 * user, in one `psql -f` session (so the auth context only needs setting
 * once). `select set_config(...) \gset` assigns the call's return value to
 * a throwaway psql variable instead of printing it — plain `-t -A` tuple
 * output would otherwise include that row ahead of each query's real
 * results and corrupt the parse below. A `\echo` marker between queries
 * delimits each query's block of returned document_title rows in the
 * combined stdout, since psql's own multi-statement output has no other
 * structure to split on.
 */
async function runQueries({ dbName, userId, queries, queryEmbeddings, hybrid }) {
  const tag = dollarTag();
  const authJson = JSON.stringify({ sub: userId, role: "authenticated" });
  const lines = [
    // is_local=false (session-level): outside an explicit transaction block
    // each top-level statement in this file runs in its own implicit
    // transaction, so a `true` (local) setting would reset again before the
    // very next statement — same class of bug as indexCorpus avoids above.
    `select set_config('request.jwt.claims', ${dq(tag, authJson)}, false) as _ignore`,
    `\\gset`,
    `set role authenticated;`,
  ];

  queries.forEach((q, i) => {
    const vector = queryEmbeddings.find((qe) => qe.query === q.query).vector;
    const queryText = hybrid ? q.query : "";
    lines.push(`\\echo ===Q${i}===`);
    lines.push(
      `select document_title from public.match_document_chunks(` +
        `'${pgVectorLiteral(vector)}'::extensions.vector, ${dq(tag, queryText)}, ${MATCH_COUNT}, ${MIN_SIMILARITY}, null, null` +
        `) order by score desc;`,
    );
  });

  const scriptDir = await mkdtemp(path.join(os.tmpdir(), "kb-eval-query-"));
  const scriptPath = path.join(scriptDir, "query.sql");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(scriptPath, lines.join("\n"));

  let stdout;
  try {
    stdout = psql(dbUrl(dbName), ["-t", "-A", "-q", "-f", scriptPath]);
  } finally {
    await rm(scriptDir, { recursive: true, force: true });
  }

  // Split the combined output on the \echo markers. Every marker line and
  // every blank line is discarded; everything else in a block is one
  // returned chunk's document_title, in the RPC's own score-desc order.
  const rankedTitlesPerQuery = queries.map(() => []);
  let current = -1;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const marker = /^===Q(\d+)===$/.exec(trimmed);
    if (marker) {
      current = Number(marker[1]);
      continue;
    }
    if (current >= 0) rankedTitlesPerQuery[current].push(trimmed);
  }
  return rankedTitlesPerQuery;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function evaluate(rankedTitlesPerQuery, queries) {
  let hit1 = 0;
  let hit3 = 0;
  let hit8 = 0;
  let reciprocalRankSum = 0;

  queries.forEach((q, i) => {
    const ranked = rankedTitlesPerQuery[i] ?? [];
    const relevant = new Set(q.relevantTitles);
    const rank = ranked.findIndex((title) => relevant.has(title));
    if (rank !== -1) {
      reciprocalRankSum += 1 / (rank + 1);
      if (rank < 1) hit1++;
      if (rank < 3) hit3++;
      if (rank < 8) hit8++;
    }
  });

  const n = queries.length;
  return {
    "hit@1": hit1 / n,
    "hit@3": hit3 / n,
    "hit@8": hit8 / n,
    mrr: reciprocalRankSum / n,
  };
}

function fmtPct(x) {
  return `${(x * 100).toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_OPTIONS = { targetTokens: 450, maxTokens: 600, overlapTokens: 60 };

const CONFIGS = [
  { key: "baseline", label: "Baseline — hybrid, default chunking, breadcrumb", hybrid: true, breadcrumb: true, chunkOptions: DEFAULT_CHUNK_OPTIONS },
  { key: "vector-only", label: "Vector-only — semantic search alone (no keyword branch)", hybrid: false, breadcrumb: true, chunkOptions: DEFAULT_CHUNK_OPTIONS },
  { key: "small-chunks", label: "Small chunks — ~150 target tokens", hybrid: true, breadcrumb: true, chunkOptions: { targetTokens: 150, maxTokens: 220, overlapTokens: 30 } },
  { key: "large-chunks", label: "Large chunks — ~900 target tokens", hybrid: true, breadcrumb: true, chunkOptions: { targetTokens: 900, maxTokens: 1100, overlapTokens: 100 } },
  { key: "no-breadcrumb", label: "No heading breadcrumb in embedding input", hybrid: true, breadcrumb: false, chunkOptions: DEFAULT_CHUNK_OPTIONS },
];

// ---------------------------------------------------------------------------

async function main() {
  const golden = await loadGolden();
  const ai = createAi(process.env);
  console.log(`\n[eval-retrieval] embedding model: ${ai.embeddings.descriptor.provider}/${ai.embeddings.descriptor.model}`);
  console.log(`[eval-retrieval] corpus: ${golden.documents.length} documents, ${golden.queries.length} queries\n`);

  // Every query's own embedding is identical across all configs (query text
  // never changes; only how chunks were produced does), so it's computed
  // once up front rather than once per config.
  const { vectors: queryVectors } = await ai.embeddings.embed(golden.queries.map((q) => q.query));
  const queryEmbeddings = golden.queries.map((q, i) => ({ query: q.query, vector: queryVectors[i] }));

  const results = [];

  for (const config of CONFIGS) {
    console.log(`→ ${config.label}`);
    const dbName = `${EVAL_DB}_${config.key.replace(/-/g, "_")}`;
    await bootstrapDb(dbName);
    try {
      const { userId } = await indexCorpus({ dbName, documents: golden.documents, config, ai });

      const rankedTitlesPerQuery = await runQueries({
        dbName,
        userId,
        queries: golden.queries,
        queryEmbeddings,
        hybrid: config.hybrid,
      });

      const metrics = evaluate(rankedTitlesPerQuery, golden.queries);
      results.push({ config, metrics });
      console.log(
        `  hit@1 ${fmtPct(metrics["hit@1"])}  hit@3 ${fmtPct(metrics["hit@3"])}  hit@8 ${fmtPct(metrics["hit@8"])}  MRR ${metrics.mrr.toFixed(2)}\n`,
      );
    } finally {
      dropDb(dbName);
    }
  }

  console.log("Summary\n" + "-".repeat(78));
  console.log(
    `${"config".padEnd(46)}${"hit@1".padStart(7)}${"hit@3".padStart(7)}${"hit@8".padStart(7)}${"mrr".padStart(7)}`,
  );
  for (const { config, metrics } of results) {
    console.log(
      `${config.label.padEnd(46)}${fmtPct(metrics["hit@1"]).padStart(7)}${fmtPct(metrics["hit@3"]).padStart(7)}${fmtPct(metrics["hit@8"]).padStart(7)}${metrics.mrr.toFixed(2).padStart(7)}`,
    );
  }
  console.log("");
}

main().catch((error) => {
  console.error(`\n[eval-retrieval] failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
