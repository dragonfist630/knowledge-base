#!/usr/bin/env node
// Downloads a static PostgREST binary for the current host into
// .cache/postgrest/<version>/postgrest, so apps/api's Gate 3 e2e harness
// (apps/api/test/e2e/global-setup.ts) has a real PostgREST to run against
// with no Docker required — see docs/DECISIONS.md Phase 3, D3.1.
//
// Usage: node scripts/e2e-fetch-postgrest.mjs
// Prints the resolved binary path on stdout on success (and does nothing —
// exit 0 — if a usable binary is already cached or already on PATH).
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execFileSync, spawnSync } from "node:child_process";

const VERSION = "12.2.3";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(REPO_ROOT, ".cache", "postgrest", VERSION);
const BIN_PATH = path.join(CACHE_DIR, "postgrest");

// PostgREST's release assets, keyed by `${process.platform}-${process.arch}`.
// There is no native darwin-arm64 static build for this version: on Apple
// Silicon this falls back to the x64 build, which needs Rosetta 2 (already
// present on most dev machines) — or, better, `brew install postgrest` for
// a native arm64 binary if one is available in Homebrew.
const ASSETS = {
  "linux-x64": "postgrest-v12.2.3-linux-static-x64.tar.xz",
  "darwin-x64": "postgrest-v12.2.3-macos-x64.tar.xz",
  "darwin-arm64": "postgrest-v12.2.3-macos-x64.tar.xz", // Rosetta 2 required — see note above.
};

function alreadyOnPath() {
  const result = spawnSync("postgrest", ["--help"], { stdio: "ignore" });
  return result.status === 0 || result.status === 1; // --help/-h exits nonzero on some builds; a spawn that ran at all is enough.
}

export async function resolvePostgrestBinary() {
  if (process.env.POSTGREST_BIN && existsSync(process.env.POSTGREST_BIN)) {
    return process.env.POSTGREST_BIN;
  }
  if (existsSync(BIN_PATH)) {
    return BIN_PATH;
  }
  if (alreadyOnPath()) {
    return "postgrest";
  }

  const key = `${process.platform}-${process.arch}`;
  const asset = ASSETS[key];
  if (!asset) {
    throw new Error(
      `No known PostgREST static build for ${key}. Install PostgREST yourself (e.g. \`brew install postgrest\` ` +
        `on macOS) and set POSTGREST_BIN to its path, or add an entry to scripts/e2e-fetch-postgrest.mjs's ASSETS map.`,
    );
  }
  if (key === "darwin-arm64") {
    console.warn(
      "[e2e-fetch-postgrest] No native darwin-arm64 PostgREST build for v12.2.3 — downloading the x64 build, " +
        "which requires Rosetta 2. If `brew install postgrest` gives you a native binary, prefer that (put it on " +
        "PATH, or set POSTGREST_BIN) instead of relying on this download.",
    );
  }

  await mkdir(CACHE_DIR, { recursive: true });
  const url = `https://github.com/PostgREST/postgrest/releases/download/v${VERSION}/${asset}`;
  const tarPath = path.join(CACHE_DIR, asset);

  console.warn(`[e2e-fetch-postgrest] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download PostgREST from ${url}: HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(tarPath));

  // .tar.xz — Node's zlib only speaks gzip, so shell out to `tar` (present
  // on every macOS/Linux dev machine this repo targets) rather than adding
  // an xz-decoding dependency for a one-time dev-tooling download.
  execFileSync("tar", ["-xf", tarPath, "-C", CACHE_DIR]);
  await rm(tarPath);

  const extracted = (await readdir(CACHE_DIR)).find((name) => name === "postgrest");
  if (!extracted) {
    throw new Error(`Expected a 'postgrest' binary after extracting ${asset}, found: ${(await readdir(CACHE_DIR)).join(", ")}`);
  }
  await chmod(BIN_PATH, 0o755);
  return BIN_PATH;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  resolvePostgrestBinary()
    .then((binPath) => {
      console.log(binPath);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
