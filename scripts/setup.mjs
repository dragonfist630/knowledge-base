#!/usr/bin/env node
// One-command setup: `pnpm setup`.
//
// Idempotent — safe to re-run. Never overwrites an `.env` value the user has
// already set. Stops on the first failure with a colored, actionable hint
// rather than a stack trace.

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import pc from "picocolors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const ENV_EXAMPLE_PATH = path.join(ROOT, ".env.example");

function step(label) {
  console.log(`\n${pc.bold(pc.cyan("→"))} ${pc.bold(label)}`);
}

function ok(message) {
  console.log(`  ${pc.green("✓")} ${message}`);
}

function info(message) {
  console.log(`  ${pc.dim("·")} ${message}`);
}

function warn(message) {
  console.log(`  ${pc.yellow("!")} ${message}`);
}

/** Print a fix-it hint and exit non-zero. Setup always stops on the first
 * unrecoverable failure instead of limping forward. */
function fail(message, hint) {
  console.error(`\n  ${pc.red("✗")} ${pc.bold(message)}`);
  if (hint) console.error(`  ${pc.dim(hint)}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: opts.silent ? "pipe" : "inherit",
    encoding: "utf8",
    ...opts,
  });
}

function commandExists(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [cmd], { stdio: "ignore" }).status === 0;
}

// ---------------------------------------------------------------------------

console.log(pc.bold("\nKnowledge Base — setup\n"));

step("Checking prerequisites");

const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  fail(
    `Node ${process.versions.node} found, but Node >= 22 is required.`,
    "Install Node 22 LTS (see .nvmrc), e.g. with nvm: `nvm install` then `nvm use`.",
  );
}
ok(`Node ${process.versions.node}`);

if (!commandExists("pnpm")) {
  fail(
    "pnpm was not found on PATH.",
    "Install it from https://pnpm.io/installation, e.g. `corepack enable`.",
  );
}
const pnpmVersion = execFileSync("pnpm", ["--version"]).toString().trim();
ok(`pnpm ${pnpmVersion}`);

const dockerAvailable = commandExists("docker");
const dockerRunning =
  dockerAvailable && run("docker", ["info"], { silent: true }).status === 0;

if (!dockerAvailable) {
  fail(
    "Docker was not found on PATH.",
    "Local Supabase runs on Docker. Install Docker Desktop: https://docs.docker.com/get-docker/\n" +
      "  Already have a hosted Supabase project instead? See \"Hosted Supabase\" in the README and re-run with SKIP_DOCKER=1.",
  );
}
if (!dockerRunning && !process.env.SKIP_DOCKER) {
  fail(
    "Docker is installed but the daemon isn't reachable.",
    "Start Docker Desktop (or `sudo systemctl start docker`) and re-run `pnpm setup`.\n" +
      "  Already have a hosted Supabase project instead? See \"Hosted Supabase\" in the README and re-run with SKIP_DOCKER=1.",
  );
}
if (dockerRunning) ok("Docker is running");
if (!dockerRunning && process.env.SKIP_DOCKER) {
  warn("SKIP_DOCKER=1 set — skipping local Supabase. Set SUPABASE_URL/keys yourself (see README → Hosted Supabase).");
}

// ---------------------------------------------------------------------------

step("Installing dependencies");
{
  const result = run("pnpm", ["install"]);
  if (result.status !== 0) fail("pnpm install failed.", "Scroll up for the underlying error.");
  ok("Dependencies installed");
}

// ---------------------------------------------------------------------------

step("Writing .env");
if (!existsSync(ENV_PATH)) {
  copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
  ok("Created .env from .env.example");
} else {
  ok(".env already exists (left untouched)");
}

function readEnvFile() {
  const text = readFileSync(ENV_PATH, "utf8");
  const lines = text.split("\n");
  const values = new Map();
  for (const line of lines) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2]);
  }
  return { text, lines, values };
}

/** Set KEY=value in .env, only if KEY is currently unset/empty. Never
 * clobbers a value the user already typed in. */
function setEnvIfEmpty(updates) {
  const { lines, values } = readEnvFile();
  let changed = false;
  const seen = new Set();

  const nextLines = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) return line;
    const [, key] = match;
    if (!(key in updates)) return line;
    seen.add(key);
    const current = values.get(key);
    if (current && current.length > 0) return line; // don't overwrite
    changed = true;
    return `${key}=${updates[key]}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${value}`);
      changed = true;
    }
  }

  if (changed) writeFileSync(ENV_PATH, nextLines.join("\n"));
  return changed;
}

// ---------------------------------------------------------------------------

let supabaseUp = false;

if (dockerRunning) {
  step("Starting local Supabase");
  if (!existsSync(path.join(ROOT, "supabase", "config.toml"))) {
    info("No supabase/config.toml yet — that lands in Phase 1. Skipping `supabase start`.");
  } else {
    const start = run("pnpm", ["exec", "supabase", "start"]);
    if (start.status !== 0) {
      fail(
        "`supabase start` failed.",
        "Scroll up for the underlying error, or run `pnpm db:stop` and try again.",
      );
    }
    supabaseUp = true;
    ok("Local Supabase is running");

    const statusResult = run("pnpm", ["exec", "supabase", "status", "-o", "env"], {
      silent: true,
    });
    if (statusResult.status === 0) {
      const parsed = new Map();
      for (const line of statusResult.stdout.split("\n")) {
        const match = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
        if (match) parsed.set(match[1], match[2]);
      }
      const apiUrl = parsed.get("API_URL") ?? parsed.get("SUPABASE_URL");
      const anonKey = parsed.get("ANON_KEY") ?? parsed.get("PUBLISHABLE_KEY");
      const serviceRoleKey = parsed.get("SERVICE_ROLE_KEY");
      const wrote = setEnvIfEmpty({
        ...(apiUrl ? { SUPABASE_URL: apiUrl, NEXT_PUBLIC_SUPABASE_URL: apiUrl } : {}),
        ...(anonKey
          ? {
              SUPABASE_PUBLISHABLE_KEY: anonKey,
              NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonKey,
            }
          : {}),
        ...(serviceRoleKey ? { SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey } : {}),
      });
      ok(wrote ? "Wrote Supabase URL/keys into .env" : "Supabase URL/keys already set in .env");
    } else {
      warn("Could not parse `supabase status -o env` — set SUPABASE_URL/keys manually.");
    }

    step("Applying migrations");
    const reset = run("pnpm", ["exec", "supabase", "db", "reset"]);
    if (reset.status !== 0) {
      fail("`supabase db reset` failed.", "Scroll up for the underlying error.");
    }
    ok("Migrations applied");
  }
}

// ---------------------------------------------------------------------------

step("AI provider");
{
  const { values } = readEnvFile();
  const hasKey = Object.keys(process.env).some(
    (k) => /_API_KEY$/.test(k) && process.env[k],
  );
  const chatProvider = values.get("AI_CHAT_PROVIDER");
  if (!hasKey && (!chatProvider || chatProvider === "mock")) {
    setEnvIfEmpty({ AI_CHAT_PROVIDER: "mock", AI_EMBEDDING_PROVIDER: "mock" });
    warn(
      "Running in keyless demo mode (AI_CHAT_PROVIDER=mock). Add OPENAI_API_KEY to .env for real answers.",
    );
  } else {
    ok(`AI_CHAT_PROVIDER=${chatProvider ?? "(set via environment)"}`);
  }
}

// ---------------------------------------------------------------------------

step("Building packages");
{
  // Also builds apps/api (turbo's build task depends on `^build`, so
  // packages/* still build first) — not just packages/*. `pnpm ai:check`
  // and `pnpm seed` both need apps/api/dist, and without this they used to
  // fail with a confusing `Cannot find module '.../dist/cli/ai-check.js'`
  // right after a supposedly-complete `pnpm setup`, since nothing before
  // this ever built apps/api. apps/web is deliberately left out here — it
  // takes noticeably longer and nothing setup.mjs itself still needs to run
  // (seeding calls the API directly, not through Next) requires it; `pnpm
  // dev`/`pnpm build` build it themselves. See docs/DECISIONS.md Phase 6,
  // D6.17.
  const build = run("pnpm", ["exec", "turbo", "build", "--filter=./packages/*", "--filter=api"]);
  if (build.status !== 0) fail("Building packages/* and apps/api failed.", "Scroll up for the underlying error.");
  ok("packages/* and apps/api built");
}

// scripts/seed.mjs talks to apps/api over HTTP (POST /documents, etc. —
// see its own docstring), and nothing before this point in setup ever
// starts apps/api listening on a port; building it above only produces
// dist/, it doesn't run it. Calling seed.mjs directly here always failed
// with a connection error, silently swallowed by the warn() below —
// `pnpm setup` never actually seeded anything, while unconditionally
// printing "Demo login: demo@example.com / demo-password-123" at the end
// as if it had. Fixed by not attempting it here at all — accurate
// guidance below instead of a doomed attempt — rather than adding a
// second background server (with its own port-conflict/orphaned-process
// failure modes) into an already-long setup script; see
// docs/DECISIONS.md Phase 6, D6.17, and check-dev-boot.mjs's own doc
// comment for why this repo prefers an explicit, separate step over a
// spawned dev server inside an automated one.
step("Demo data");
if (supabaseUp) {
  info("Not seeded yet — that needs apps/api actually running, which `pnpm setup` doesn't start on its own.");
  info("Run `pnpm dev`, then in a second terminal `pnpm seed`, to create it.");
} else {
  info("Skipped (local Supabase isn't running). Run `pnpm seed` once it's up.");
}

// ---------------------------------------------------------------------------

console.log(`\n${pc.bold(pc.green("Setup complete."))}\n`);
console.log(`  Web:              ${pc.underline("http://localhost:3000")}`);
console.log(`  API health check: ${pc.underline("http://localhost:3001/health")}`);
if (supabaseUp) {
  console.log(`  Supabase Studio:  ${pc.underline("http://localhost:54323")}`);
}
console.log(`\n  Next: ${pc.bold("pnpm dev")}`);
if (supabaseUp) {
  console.log(
    `  Then: ${pc.bold("pnpm seed")} ${pc.dim(`(creates the demo login demo@example.com / demo-password-123 and sample documents)`)}\n`,
  );
} else {
  console.log("");
}
