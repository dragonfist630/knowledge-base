import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFile, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";

import { resolvePostgrestBinary } from "./postgrest-binary.js";
import { mintJwt } from "./jwt.js";
import { startRestProxy, stopRestProxy } from "./rest-proxy.js";

/**
 * Gate 3's e2e harness, no Docker required — see docs/DECISIONS.md Phase 3
 * (D3.1) for the full rationale. This file is a Vitest `globalSetup`
 * module (see vitest.config.e2e.ts): `setup()` runs once before the whole
 * `*.e2e-spec.ts` suite, `teardown()` runs once after.
 *
 * It needs a *running* Postgres reachable as a superuser — it does not try
 * to start Postgres itself, since "start Postgres" is too platform-specific
 * to do reliably from Node (Postgres.app vs. Homebrew services vs. a
 * system service differ by OS and by machine). Point
 * E2E_POSTGRES_SUPERUSER_URL at one; it defaults to the common local dev
 * default (postgres/postgres on 127.0.0.1:5432).
 *
 * What it *does* orchestrate: an ephemeral `kb_e2e_test` database (dropped
 * and recreated every run, so the suite starts from a known state), the
 * bootstrap.sql auth shim + the real supabase/migrations/*.sql applied
 * unmodified, a real PostgREST binary (auto-downloaded if needed — see
 * scripts/e2e-fetch-postgrest.mjs), the /rest/v1-stripping reverse proxy
 * apps/api's SUPABASE_URL needs to point at (rest-proxy.ts), and two seeded
 * auth.users rows with hand-minted JWTs (jwt.ts) for the two-user
 * CRUD/isolation scenarios in documents.e2e-spec.ts.
 *
 * Env vars for the test *process* (SUPABASE_URL, SUPABASE_JWT_SECRET, ...)
 * can't just be set here on `process.env` — Vitest's workers are separate
 * processes and don't reliably inherit mutations made after they've
 * started. Instead this writes them, plus the two seeded users' ids/JWTs,
 * to RUNTIME_FILE, and env.setup.ts (a per-worker `setupFiles` entry, which
 * *does* run inside the worker) reads that file and sets `process.env`
 * there before any spec file's imports resolve AppModule.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
export const RUNTIME_FILE = path.join(__dirname, ".runtime.json");

const SUPERUSER_URL = process.env.E2E_POSTGRES_SUPERUSER_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const TEST_DB = "kb_e2e_test";
const POSTGREST_PORT = Number(process.env.E2E_POSTGREST_PORT ?? 3111);
const PROXY_PORT = Number(process.env.E2E_PROXY_PORT ?? 3110);
// The fixed secret every bare `supabase start` signs local dev JWTs with —
// see supabase/config.toml's closing note and docs/DECISIONS.md D3.1.
const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

function testDbUrl(): string {
  const u = new URL(SUPERUSER_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

function authenticatorUrl(): string {
  const u = new URL(SUPERUSER_URL);
  u.username = "authenticator";
  u.password = "authenticator";
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

function psql(url: string, args: string[]): { stdout: string; status: number | null } {
  const result = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8" });
  if (result.error) {
    throw new Error(
      `Could not run psql (${result.error.message}). The Gate 3 e2e suite needs a real local Postgres — see ` +
        `docs/DECISIONS.md Phase 3, D3.1 for setup notes (this machine may need e.g. \`brew install postgresql@16\` ` +
        `or \`apt install postgresql-client\`; Docker/supabase start is not required or used here).`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`psql exited ${result.status}: ${result.stderr}`);
  }
  return { stdout: result.stdout, status: result.status };
}

function psqlCapture(url: string, sql: string): string {
  // -q suppresses the "INSERT 0 1"/"UPDATE 1" command-tag line that
  // otherwise gets concatenated onto -t -A's tuple output for DML.
  return psql(url, ["-t", "-A", "-q", "-c", sql]).stdout.trim();
}

async function waitForPostgrest(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`PostgREST never became ready on port ${port}: ${String(lastError)}`);
}

interface SeededUser {
  id: string;
  email: string;
  jwt: string;
}

async function seedUser(email: string): Promise<SeededUser> {
  psql(testDbUrl(), ["-q", "-c", `insert into auth.users (email) values ('${email}') on conflict do nothing;`]);
  const id = psqlCapture(testDbUrl(), `select id from auth.users where email = '${email}';`);
  if (!id) {
    throw new Error(`Failed to seed test user ${email}`);
  }
  return { id, email, jwt: mintJwt({ sub: id, email, secret: JWT_SECRET }) };
}

let postgrestProcess: ChildProcess | undefined;
let proxyServer: Server | undefined;

export async function setup(): Promise<void> {
  // 1. Fresh ephemeral database.
  psql(SUPERUSER_URL, ["-q", "-c", `drop database if exists ${TEST_DB};`]);
  psql(SUPERUSER_URL, ["-q", "-c", `create database ${TEST_DB};`]);

  // 2. Auth shim, then the real migrations, unmodified.
  psql(testDbUrl(), ["-q", "-f", path.join(__dirname, "bootstrap.sql")]);
  const migrationsDir = path.join(REPO_ROOT, "supabase", "migrations");
  const migrations = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) {
    psql(testDbUrl(), ["-q", "-f", path.join(migrationsDir, migration)]);
  }

  // 3. Real PostgREST, pointed at the authenticator role.
  const postgrestBin = await resolvePostgrestBinary();
  const confPath = path.join(os.tmpdir(), `kb-e2e-postgrest-${process.pid}.conf`);
  await writeFile(
    confPath,
    [
      `db-uri = "${authenticatorUrl()}"`,
      `db-schemas = "public"`,
      `db-anon-role = "anon"`,
      `jwt-secret = "${JWT_SECRET}"`,
      `jwt-role-claim-key = ".role"`,
      `server-host = "127.0.0.1"`,
      `server-port = ${POSTGREST_PORT}`,
    ].join("\n"),
  );
  postgrestProcess = spawn(postgrestBin, [confPath], { stdio: "pipe" });
  postgrestProcess.on("error", (err) => {
    throw new Error(`Failed to start PostgREST (${postgrestBin}): ${err.message}`);
  });
  await waitForPostgrest(POSTGREST_PORT);

  // 4. The /rest/v1-stripping proxy supabase-js's fixed URL shape needs.
  proxyServer = await startRestProxy(PROXY_PORT, POSTGREST_PORT);

  // 5. Two seeded users + minted JWTs for the isolation scenarios.
  const userA = await seedUser("e2e-user-a@example.com");
  const userB = await seedUser("e2e-user-b@example.com");

  await writeFile(
    RUNTIME_FILE,
    JSON.stringify(
      {
        SUPABASE_URL: `http://127.0.0.1:${PROXY_PORT}`,
        SUPABASE_JWT_SECRET: JWT_SECRET,
        userA,
        userB,
      },
      null,
      2,
    ),
  );
}

export async function teardown(): Promise<void> {
  if (proxyServer) {
    await stopRestProxy(proxyServer);
  }
  if (postgrestProcess && !postgrestProcess.killed) {
    postgrestProcess.kill("SIGTERM");
  }
  if (existsSync(RUNTIME_FILE)) {
    await rm(RUNTIME_FILE);
  }
  try {
    psql(SUPERUSER_URL, ["-q", "-c", `drop database if exists ${TEST_DB};`]);
  } catch {
    // Best-effort — a leftover kb_e2e_test database is harmless and gets
    // dropped-and-recreated by the next run's setup() anyway.
  }
}

// Re-exported only so env.setup.ts (which runs in a different process) can
// share the same "what does the runtime file look like" type.
export interface E2eRuntime {
  SUPABASE_URL: string;
  SUPABASE_JWT_SECRET: string;
  userA: SeededUser;
  userB: SeededUser;
}

export async function readRuntime(): Promise<E2eRuntime> {
  return JSON.parse(await readFile(RUNTIME_FILE, "utf8"));
}
