import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execFileSync, spawnSync } from "node:child_process";

/**
 * Locates (downloading if necessary) a static PostgREST binary for Gate
 * 3's e2e harness — see docs/DECISIONS.md Phase 3, D3.1. This is a TS
 * near-duplicate of scripts/e2e-fetch-postgrest.mjs's logic rather than a
 * shared import: apps/api's tsconfig.json scopes `rootDir` to apps/api
 * itself (see @kb/tsconfig/nestjs.json), so `tsc --noEmit` rejects an
 * import reaching outside it into the repo-root scripts/ directory. Keep
 * the two in sync if this logic changes; scripts/e2e-fetch-postgrest.mjs
 * stays too, as the standalone `node scripts/e2e-fetch-postgrest.mjs`
 * entry point for pre-fetching the binary outside a test run.
 */

const VERSION = "12.2.3";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CACHE_DIR = path.join(REPO_ROOT, ".cache", "postgrest", VERSION);
const BIN_PATH = path.join(CACHE_DIR, "postgrest");

const ASSETS: Record<string, string> = {
  "linux-x64": "postgrest-v12.2.3-linux-static-x64.tar.xz",
  "darwin-x64": "postgrest-v12.2.3-macos-x64.tar.xz",
  "darwin-arm64": "postgrest-v12.2.3-macos-x64.tar.xz", // Rosetta 2 required — no native build for this version.
};

function alreadyOnPath(): boolean {
  const result = spawnSync("postgrest", ["--help"], { stdio: "ignore" });
  return result.status === 0 || result.status === 1;
}

export async function resolvePostgrestBinary(): Promise<string> {
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
        `on macOS) and set POSTGREST_BIN to its path, or add an entry to this file's ASSETS map.`,
    );
  }
  if (key === "darwin-arm64") {
    console.warn(
      "[postgrest-binary] No native darwin-arm64 PostgREST build for v12.2.3 — downloading the x64 build, which " +
        "requires Rosetta 2. Prefer `brew install postgrest` (native arm64, if available) and set POSTGREST_BIN " +
        "instead, when that's an option.",
    );
  }

  await mkdir(CACHE_DIR, { recursive: true });
  const url = `https://github.com/PostgREST/postgrest/releases/download/v${VERSION}/${asset}`;
  const tarPath = path.join(CACHE_DIR, asset);

  console.warn(`[postgrest-binary] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download PostgREST from ${url}: HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(tarPath));

  execFileSync("tar", ["-xf", tarPath, "-C", CACHE_DIR]);
  await rm(tarPath);

  if (!existsSync(BIN_PATH)) {
    throw new Error(`Expected a 'postgrest' binary after extracting ${asset}, found: ${(await readdir(CACHE_DIR)).join(", ")}`);
  }
  await chmod(BIN_PATH, 0o755);
  return BIN_PATH;
}
