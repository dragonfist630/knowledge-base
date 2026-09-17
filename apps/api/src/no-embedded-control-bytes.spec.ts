import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Regression test: `documents.service.ts`'s `computeContentHash` once had
 * a *literal raw NUL byte* embedded in its source (inside
 * `.update("\0")`) instead of the two-character escape sequence `\0` —
 * both produce the identical runtime string, so nothing behavioral ever
 * broke, but the raw byte made the whole file get misclassified as binary
 * by `file`/`grep`/etc, invisible to `tsc`, `eslint`, and every other test.
 * See docs/DECISIONS.md Phase 3, D3.7.
 *
 * This scans every non-spec .ts file under apps/api/src for any raw
 * control byte below 0x20 other than tab/newline/carriage-return, so this
 * class of bug fails a real test the next time it happens, rather than
 * needing another manual re-validation pass to notice.
 */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), ".");
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d]); // tab, \n, \r

function listFilesRecursive(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts") && !entry.endsWith(".e2e-spec.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function hasRawControlByte(file: string): boolean {
  const buffer = readFileSync(file);
  for (const byte of buffer) {
    if (byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte)) {
      return true;
    }
  }
  return false;
}

describe("source hygiene: no raw control bytes under apps/api/src", () => {
  it("every .ts file is plain text — no embedded NUL or other raw control characters", () => {
    const offenders = listFilesRecursive(SRC_DIR)
      .filter(hasRawControlByte)
      .map((file) => file.replace(`${SRC_DIR}/`, ""));

    expect(offenders).toEqual([]);
  });
});
