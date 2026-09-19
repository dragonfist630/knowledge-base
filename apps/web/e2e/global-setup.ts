import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";

import { resolvePostgrestBinary } from "./support/postgrest-binary.js";
import { startAuthGateway, stopAuthGateway } from "./support/auth-gateway.js";
import {
  E2E_DB_NAME,
  E2E_GATEWAY_PORT,
  E2E_JWT_SECRET,
  E2E_POSTGREST_PORT,
  E2E_SUPERUSER_URL,
  E2E_WEB_URL,
} from "./support/constants.js";

/**
 * Gate 6's Playwright globalSetup: brings up the same kind of Docker-free
 * ephemeral backend apps/api's Gate 3 e2e harness uses (test/e2e/global-setup.ts
 * — see docs/DECISIONS.md D3.1), reused here so a *real browser* driving
 * apps/web has something real to talk to.
 *
 * Unlike Gate 3's harness, this one does NOT spawn apps/api or apps/web
 * themselves — those run as ordinary `webServer` entries in
 * playwright.config.ts, started against the fixed ports/secrets in
 * support/constants.ts. Playwright starts `webServer`s *before* running
 * globalSetup (its runner queues webServer plugin-setup tasks ahead of the
 * user globalSetup task), so by the time any test actually runs, both the
 * dev servers and this database/PostgREST/auth-gateway stack are up —
 * their relative boot order doesn't matter because neither apps/api nor
 * apps/web touches Supabase at process boot, only per-request.
 *
 * What this sets up: a fresh `kb_e2e_web` database (dropped + recreated
 * every run), the same bootstrap.sql auth shim + real
 * supabase/migrations/*.sql (unmodified) Gate 3 uses, a real PostgREST
 * binary bound to the `authenticator` role, and support/auth-gateway.ts's
 * GoTrue-compatible shim in front of it. No users are pre-seeded — the
 * smoke test signs up its own account through the real UI, exactly like a
 * first-time user would.
 *
 * Exports the default globalSetup shape Playwright expects: the returned
 * function becomes globalTeardown, so there's no separate
 * global-teardown.ts module (nothing torn down here is anything but
 * process-local state captured by this closure).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
// Reused by relative path, not duplicated — it's read at runtime via
// `psql -f`, not imported as a TS module, so apps/web's tsconfig rootDir
// restriction (which forced constants.ts/jwt.ts/postgrest-binary.ts/
// auth-gateway.ts to be near-duplicates) doesn't apply to it.
const BOOTSTRAP_SQL = path.join(REPO_ROOT, "apps", "api", "test", "e2e", "bootstrap.sql");

function dbUrl(): string {
  const u = new URL(E2E_SUPERUSER_URL);
  u.pathname = `/${E2E_DB_NAME}`;
  return u.toString();
}

function authenticatorUrl(): string {
  const u = new URL(E2E_SUPERUSER_URL);
  u.username = "authenticator";
  u.password = "authenticator";
  u.pathname = `/${E2E_DB_NAME}`;
  return u.toString();
}

function psql(url: string, args: string[]): void {
  const result = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8" });
  if (result.error) {
    throw new Error(
      `Could not run psql (${result.error.message}). Gate 6's e2e harness needs a real local Postgres reachable ` +
        `at E2E_POSTGRES_SUPERUSER_URL (default postgres/postgres on 127.0.0.1:5432) — see docs/DECISIONS.md D3.1.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`psql exited ${result.status}: ${result.stderr}`);
  }
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

let postgrestProcess: ChildProcess | undefined;
let gatewayServer: Server | undefined;

async function teardown(): Promise<void> {
  if (gatewayServer) {
    await stopAuthGateway(gatewayServer);
  }
  if (postgrestProcess && !postgrestProcess.killed) {
    postgrestProcess.kill("SIGTERM");
  }
  try {
    psql(E2E_SUPERUSER_URL, ["-q", "-c", `drop database if exists ${E2E_DB_NAME};`]);
  } catch {
    // Best-effort — a leftover kb_e2e_web database is harmless and gets
    // dropped-and-recreated by the next run's globalSetup() anyway.
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // 1. Fresh ephemeral database.
  psql(E2E_SUPERUSER_URL, ["-q", "-c", `drop database if exists ${E2E_DB_NAME};`]);
  psql(E2E_SUPERUSER_URL, ["-q", "-c", `create database ${E2E_DB_NAME};`]);

  // 2. Auth shim, then the real migrations, unmodified.
  psql(dbUrl(), ["-q", "-f", BOOTSTRAP_SQL]);
  const migrationsDir = path.join(REPO_ROOT, "supabase", "migrations");
  const migrations = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) {
    psql(dbUrl(), ["-q", "-f", path.join(migrationsDir, migration)]);
  }

  // 3. Real PostgREST, pointed at the authenticator role.
  const postgrestBin = await resolvePostgrestBinary();
  const confPath = path.join(os.tmpdir(), `kb-e2e-web-postgrest-${process.pid}.conf`);
  await writeFile(
    confPath,
    [
      `db-uri = "${authenticatorUrl()}"`,
      `db-schemas = "public"`,
      `db-anon-role = "anon"`,
      `jwt-secret = "${E2E_JWT_SECRET}"`,
      `jwt-role-claim-key = ".role"`,
      `server-host = "127.0.0.1"`,
      `server-port = ${E2E_POSTGREST_PORT}`,
    ].join("\n"),
  );
  postgrestProcess = spawn(postgrestBin, [confPath], { stdio: "pipe" });
  postgrestProcess.on("error", (err) => {
    throw new Error(`Failed to start PostgREST (${postgrestBin}): ${err.message}`);
  });
  await waitForPostgrest(E2E_POSTGREST_PORT);

  // 4. The GoTrue-compatible shim + /rest/v1-stripping proxy a real browser
  // driving apps/web's @supabase/ssr client needs (see auth-gateway.ts).
  gatewayServer = await startAuthGateway({
    gatewayPort: E2E_GATEWAY_PORT,
    postgrestPort: E2E_POSTGREST_PORT,
    jwtSecret: E2E_JWT_SECRET,
    dbUrl: dbUrl(),
    webOrigin: E2E_WEB_URL,
  });

  return teardown;
}
