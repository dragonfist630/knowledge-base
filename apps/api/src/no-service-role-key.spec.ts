import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// apps/api must never read SUPABASE_SERVICE_ROLE_KEY — every query runs as
// the authenticated user under RLS (see docs/DECISIONS.md). Only
// scripts/seed.mjs, outside this package, is allowed to use it. This test
// fails the build the moment that boundary is crossed, rather than relying
// on code review to catch it.
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), ".");
const FORBIDDEN = "SUPABASE_SERVICE_ROLE_KEY";

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

describe("SUPABASE_SERVICE_ROLE_KEY boundary", () => {
  it("is never referenced anywhere under apps/api/src", () => {
    const offenders = listFilesRecursive(SRC_DIR)
      .filter((file) => readFileSync(file, "utf8").includes(FORBIDDEN))
      .map((file) => file.replace(`${SRC_DIR}/`, ""));

    expect(offenders).toEqual([]);
  });
});
