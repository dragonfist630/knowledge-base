#!/usr/bin/env node
/**
 * Puts the monorepo's single root `.env` into the real environment before
 * running `next`, so the values are already there rather than being applied
 * later as a mutation. `apps/web`'s `dev`, `build` and `start` scripts all
 * run `next` through this.
 *
 * Why it exists: `next.config.ts` also calls `loadEnvConfig` on the same
 * root, and every ordinary part of the app reads the result fine, but
 * `src/proxy.ts` does not. Next 16 renamed `middleware.ts` to `proxy.ts`
 * and its docs are explicit that Proxy "is meant to be invoked separately
 * of your render code" and that you "should not attempt relying on shared
 * modules or globals" — Turbopack builds and runs it apart from the rest
 * of the app, where a `process.env` mutation performed by application
 * config isn't visible. Loading the file out here removes the question:
 * there is no mutation to propagate. See docs/DECISIONS.md Phase 6, D6.11.
 *
 * Only `NEXT_PUBLIC_*` is taken from the file, because that is the whole
 * of this app's contract with it — those four values are the only ones
 * `apps/web` reads that the file supplies. The rest of the root `.env`
 * configures apps/api and the scripts (`PORT`, `SUPABASE_SERVICE_ROLE_KEY`,
 * the `AI_*` provider block, `NODE_ENV`, ...), and handing that to `next`
 * does real damage: `PORT=3001` made `next dev` bind the API's port
 * (D6.12), and `NODE_ENV=development` made `next build` produce a
 * development build that then crashed while prerendering (D6.13). Both
 * were the same mistake — passing a process more than it asked for — so
 * this allowlists rather than blocking known-bad names one at a time.
 *
 * Nothing already present in the real environment is touched, so
 * `PORT=3100 pnpm dev`, `CI=1`, and Gate 6's playwright `webServer.env`
 * (which sets these same keys directly) all still win over the file.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWebEnv } from "./root-env.mjs";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");

const inheritedEnv = { ...process.env };
const { combinedEnv } = loadEnvConfig(REPO_ROOT);

// loadEnvConfig applies the whole file to this process's own env; the
// child gets only what resolveWebEnv allows through (see root-env.mjs,
// and root-env.test.mjs for the regressions it exists to prevent).
const childEnv = resolveWebEnv(inheritedEnv, combinedEnv ?? {});

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/with-root-env.mjs <command> [...args]");
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: "inherit",
  env: childEnv,
  // `next` is a .cmd shim on Windows, which bare spawn can't execute.
  shell: process.platform === "win32",
});

// Forward the signals a dev server actually receives, so Ctrl+C stops
// `next dev` itself rather than orphaning it behind this wrapper.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
