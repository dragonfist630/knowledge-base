#!/usr/bin/env node
/**
 * Loads the monorepo's single root `.env` into this process's *real*
 * environment, then runs the command that follows, so the child process
 * inherits those values as genuine `process.env` entries.
 *
 * Why this exists, given next.config.ts already calls `loadEnvConfig` on
 * the same root: that call populates `process.env` inside whichever
 * process evaluates the Next config, and every ordinary part of the app
 * (pages, server components, route handlers, the browser bundle) reads
 * those values fine. `src/proxy.ts` does not. Next 16 renamed
 * `middleware.ts` to `proxy.ts` and its docs are explicit that Proxy "is
 * meant to be invoked separately of your render code" and that you
 * "should not attempt relying on shared modules or globals" — Turbopack
 * builds and runs it apart from the rest of the app, and in that context
 * a `process.env` mutation performed by application config simply isn't
 * visible. The result was `createServerClient` receiving `undefined` for
 * both Supabase arguments on every single request, while the identical
 * `loadEnvConfig` call verified correct in isolation and the root `.env`
 * was confirmed correct on disk. Putting the values in the environment
 * *before* `next` starts sidesteps the question entirely: there is no
 * mutation to propagate, because the variables are already there.
 * See docs/DECISIONS.md Phase 6, D6.11.
 *
 * `loadEnvConfig` does not overwrite variables already present in the
 * environment, so an explicit `FOO=bar pnpm dev` — and Gate 6's
 * playwright `webServer.env`, which sets these same keys directly — still
 * take precedence over the file.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");

// `PORT` in the root `.env` belongs to apps/api (see .env.example). Next
// also honours `PORT`, so injecting the file wholesale would make
// `next dev` bind the API's port and leave apps/api dead on
// `EADDRINUSE`. Anything genuinely exported in the surrounding shell is
// the developer's explicit intent and is left alone; a value that came
// only from the file is dropped, so Next falls back to its own default
// (3000). Set `WEB_PORT` in the root `.env` to move the web app instead.
const portWasExplicit = Object.hasOwn(process.env, "PORT");

loadEnvConfig(REPO_ROOT);

if (!portWasExplicit) {
  delete process.env.PORT;
  if (process.env.WEB_PORT) process.env.PORT = process.env.WEB_PORT;
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/with-root-env.mjs <command> [...args]");
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: "inherit",
  env: process.env,
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
