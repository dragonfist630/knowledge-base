#!/usr/bin/env node
/**
 * Boots apps/web exactly the way a person does — `pnpm dev`, reading the
 * root `.env` off disk — and asserts the app actually serves a page.
 *
 * This exists because Gate 6 cannot catch this class of failure and never
 * could: its playwright `webServer` passes `NEXT_PUBLIC_*` to the spawned
 * `next dev` directly as process env, so the suite has only ever run the
 * app down the one path where root-`.env` loading is bypassed entirely.
 * A fully green Gate 6 therefore said nothing about whether `pnpm dev`
 * works after a fresh clone and `pnpm setup` — which is the first thing
 * anyone does with this repo, and which was broken for three separate
 * reasons in a row (docs/DECISIONS.md D6.11, D6.12, D6.13).
 *
 * Deliberately not part of `turbo test`: it needs a free port and a
 * populated `.env`, and a mandatory gate that flakes on either is worse
 * than an explicit one. The pure env-resolution logic that actually
 * regressed is covered by apps/web/scripts/root-env.test.mjs, which does
 * run in the normal pipeline. Run this with `pnpm check:dev-boot`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.DEV_BOOT_PORT ?? 3210);
const READY_TIMEOUT_MS = 120_000;

const envPath = path.join(ROOT, ".env");
const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const missing = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"].filter(
  (key) => !new RegExp(`^${key}=.+$`, "m").test(envText),
);
if (missing.length > 0) {
  console.log(`  skipped: root .env has no ${missing.join(", ")} — run \`pnpm setup\` first.`);
  process.exit(0);
}

// Own process group, so shutting down takes the whole `pnpm -> next dev`
// tree with it rather than leaving an orphan holding the port.
const child = spawn("pnpm", ["--filter", "web", "dev"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});

function stopServer() {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

function fail(message) {
  console.error(`\n  FAIL: ${message}\n\n--- dev server output ---\n${output}\n`);
  stopServer();
  process.exit(1);
}

const started = Date.now();
while (!/Ready in|Local:\s+http/.test(output)) {
  if (child.exitCode !== null) fail(`the dev server exited with code ${child.exitCode} before becoming ready`);
  if (Date.now() - started > READY_TIMEOUT_MS) fail(`the dev server never became ready within ${READY_TIMEOUT_MS}ms`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

let response;
try {
  response = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
} catch (error) {
  fail(`the dev server became ready but the request failed: ${error.message}`);
}

const body = await response.text();
stopServer();

// The precise failure this guards against: `proxy.ts` receiving undefined
// for both Supabase arguments and throwing on every single request.
if (/URL and Key are required/i.test(body) || /URL and Key are required/i.test(output)) {
  fail("proxy.ts did not receive the Supabase values from the root .env (see docs/DECISIONS.md D6.11)");
}
if (!response.ok) fail(`GET / returned ${response.status}`);
if (!/Sign in|Sign up/i.test(body)) fail("GET / did not render the auth page");

console.log(`  ok: \`pnpm dev\` booted on :${PORT} and served the auth page using the root .env`);
process.exit(0);
