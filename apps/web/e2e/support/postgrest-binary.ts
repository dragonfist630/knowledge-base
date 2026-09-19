import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { execFileSync, spawnSync } from "node:child_process";

/**
 * Locates (downloading if necessary) a static PostgREST binary for Gate
 * 6's Playwright harness. A near-duplicate of
 * apps/api/test/e2e/postgrest-binary.ts (itself already documented there
 * as a deliberate near-duplicate of scripts/e2e-fetch-postgrest.mjs, for
 * the same reason: apps/web's tsconfig.json only `include`s files inside
 * apps/web, so an import reaching outside it fails `tsc --noEmit`). All
 * three point at the same on-disk cache dir, so whichever one runs first
 * (`pnpm seed`, apps/api's Gate 3 suite, or this one) downloads it once for
 * all of them.
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
  // apps/web's tsconfig pulls in the DOM lib (needed for browser code
  // elsewhere in this app), so `fetch`'s Response.body resolves to lib.dom's
  // ReadableStream type here rather than the Node-compatible one apps/api's
  // tsconfig (no "dom" lib) sees for the same code. At runtime this is
  // still the exact same undici stream either way — the cast below is only
  // needed because lib.dom.d.ts's ReadableStream type is missing members
  // (`values`, `Symbol.asyncIterator`) that node:stream/web's declares and
  // `Readable.fromWeb` requires, a known gap between the two lib.d.ts's.
  await pipeline(Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>), createWriteStream(tarPath));

  execFileSync("tar", ["-xf", tarPath, "-C", CACHE_DIR]);
  await rm(tarPath);

  if (!existsSync(BIN_PATH)) {
    throw new Error(`Expected a 'postgrest' binary after extracting ${asset}, found: ${(await readdir(CACHE_DIR)).join(", ")}`);
  }
  await chmod(BIN_PATH, 0o755);
  return BIN_PATH;
}
