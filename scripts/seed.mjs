#!/usr/bin/env node
// Creates a demo user (demo@example.com / demo-password-123) and a handful
// of sample documents through the API, so they go through the real indexing
// pipeline. Requires apps/api (and a reachable Supabase Auth — real or
// local) to already be running; `pnpm dev` first, then `pnpm seed`.
//
// Idempotent: re-running signs the demo user back in (rather than failing
// on "already registered") and re-creates the sample documents — duplicate
// titles are fine, POST /documents has no uniqueness constraint on title.
//
// Talks to Supabase Auth's REST API directly (not the Supabase JS SDK —
// this is a plain Node script with no framework), the same
// signup/token-password endpoints apps/web's @supabase/ssr client calls
// under the hood. Works against a real Supabase project exactly the same
// way it works against a local one.

import path from "node:path";
import { fileURLToPath } from "node:url";

import pc from "picocolors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Node >=22 (this repo's engines.node floor) can load a .env file with no
// extra dependency — see docs/DECISIONS.md. Every other script/app in this
// monorepo shares the one root `.env` (see scripts/setup.mjs).
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // No .env yet — `pnpm setup` hasn't run. Fall through; the presence
  // checks below will produce a clearer error than a raw ENOENT.
}

const DEMO_EMAIL = "demo@example.com";
const DEMO_PASSWORD = "demo-password-123";

// Same content as apps/web/src/features/documents/hooks/use-load-sample-documents.ts's
// "Load sample documents" dev button — kept as its own copy rather than a
// shared import (that file is a browser-only "use client" React hook this
// plain Node script can't pull in without a bundler; see that file's own
// doc comment for why the UI button doesn't call a dedicated seed endpoint
// either). Update both places together if the sample content changes.
const SAMPLE_DOCUMENTS = [
  {
    title: "Getting Started with the Knowledge Base",
    tags: ["guide", "onboarding"],
    content:
      "# Getting Started\n\nThis Knowledge Base lets you write documents and then ask questions about them in the Chat tab. Every document you create or edit is automatically chunked and embedded, so it becomes searchable within a few seconds.\n\n## Tips\n\n- Use headings (`#`, `##`) to organize long documents — the chunker and the chat citations both respect section boundaries.\n- Tag documents so you can filter the list and scope chat questions to just a few documents.\n- The status badge next to a document tells you whether it's still indexing.",
  },
  {
    title: "Vector Search, Briefly",
    tags: ["reference", "rag"],
    content:
      "# Vector Search, Briefly\n\nWhen you ask a question in Chat, the app doesn't search for exact keyword matches. Instead it converts your question into a numeric vector (an embedding) and compares it against the stored vectors for every chunk of your documents, using cosine similarity.\n\n## Why chunks, not whole documents\n\nEmbedding an entire long document loses detail — the vector ends up representing an average of everything in it. Splitting into smaller, heading-aware chunks keeps each vector focused on one topic, which makes retrieval far more precise.\n\n## Provider-agnostic\n\nThe chat model and the embedding model are configured independently, and either can be swapped to a different OpenAI-API-compatible provider through environment variables alone — no code changes required.",
  },
  {
    title: "Markdown Cheat Sheet",
    tags: ["reference"],
    content:
      "# Markdown Cheat Sheet\n\n## Text\n\n**bold**, *italic*, `inline code`\n\n## Lists\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n## Links and tables\n\n[Example link](https://example.com)\n\n| Column A | Column B |\n| --- | --- |\n| value | value |\n\n## Code block\n\n```ts\nfunction hello(name: string) {\n  return `Hello, ${name}!`;\n}\n```",
  },
];

function step(label) {
  console.log(`\n${pc.bold(pc.cyan("→"))} ${pc.bold(label)}`);
}

function ok(message) {
  console.log(`  ${pc.green("✓")} ${message}`);
}

function info(message) {
  console.log(`  ${pc.dim("·")} ${message}`);
}

function fail(message, hint) {
  console.error(`\n  ${pc.red("✗")} ${pc.bold(message)}`);
  if (hint) console.error(`  ${pc.dim(hint)}`);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    fail(`${name} is not set.`, "Run `pnpm setup` first (or `cp .env.example .env` and fill it in).");
  }
  return value;
}

/** POSTs JSON, throws with the response body on a non-2xx status (the auth/API error shape isn't worth typing out here — this is a dev script, not app code). */
async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message = json?.message ?? json?.error_description ?? json?.msg ?? (text || res.statusText);
    const error = new Error(message);
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return json;
}

/** Signs the demo user up; if they already exist, signs in instead — makes the script safe to re-run. */
async function ensureDemoSession(supabaseUrl, anonKey) {
  const headers = { apikey: anonKey };

  try {
    const signUp = await postJson(`${supabaseUrl}/auth/v1/signup`, { email: DEMO_EMAIL, password: DEMO_PASSWORD }, headers);
    if (signUp.access_token) {
      ok(`Created demo user ${DEMO_EMAIL}`);
      return signUp.access_token;
    }
    // Some Supabase projects have email confirmation ON, in which case
    // signup succeeds but returns a user with no session — same case
    // apps/web's signup server action handles (see app/(auth)/actions.ts).
    info("Signup succeeded but returned no session (email confirmation is likely required) — trying sign-in instead.");
  } catch (error) {
    if (error.status !== 400 && error.status !== 422) throw error;
    info(`${DEMO_EMAIL} already exists — signing in instead.`);
  }

  const signIn = await postJson(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    headers,
  );
  ok(`Signed in as ${DEMO_EMAIL}`);
  return signIn.access_token;
}

async function createSampleDocuments(apiUrl, accessToken) {
  const created = [];
  for (const doc of SAMPLE_DOCUMENTS) {
    // Sequential on purpose, same as the UI's "Load sample documents"
    // button: these hit the same per-user rate limit as any other
    // POST /documents call, and there's no reason to race them.
    const document = await postJson(`${apiUrl}/documents`, doc, { Authorization: `Bearer ${accessToken}` });
    ok(`Created "${document.title}" (${document.id})`);
    created.push(document);
  }
  return created;
}

async function main() {
  console.log(pc.bold("\nKnowledge Base — seed\n"));

  step("Reading configuration");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const anonKey = requireEnv("SUPABASE_PUBLISHABLE_KEY");
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
  ok(`Supabase URL: ${supabaseUrl}`);
  ok(`API URL: ${apiUrl}`);

  step("Creating (or signing in as) the demo user");
  let accessToken;
  try {
    accessToken = await ensureDemoSession(supabaseUrl, anonKey);
  } catch (error) {
    fail(`Could not create/sign in the demo user: ${error.message}`, `Is Supabase Auth reachable at ${supabaseUrl}?`);
  }

  step("Creating sample documents");
  try {
    await createSampleDocuments(apiUrl, accessToken);
  } catch (error) {
    fail(
      `Could not create sample documents: ${error.message}`,
      `Is apps/api running and reachable at ${apiUrl}? (\`pnpm dev\` starts it.)`,
    );
  }

  console.log(`\n${pc.bold(pc.green("Done."))} Sign in as ${pc.bold(DEMO_EMAIL)} / ${pc.bold(DEMO_PASSWORD)} to see the seeded documents.\n`);
}

main().catch((error) => {
  fail(error.message ?? String(error));
});
