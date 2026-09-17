import { existsSync, readFileSync } from "node:fs";

import { RUNTIME_FILE, type E2eRuntime } from "./global-setup.js";

/**
 * Vitest `setupFiles` entry (see vitest.config.e2e.ts) — unlike
 * `globalSetup`, this runs inside each test-file worker process, so
 * `process.env` writes here are actually visible to that worker's own
 * imports. Reads the connection info global-setup.ts's `setup()` wrote to
 * RUNTIME_FILE and sets the env vars AppModule's ConfigModule needs before
 * any spec file gets a chance to import it.
 */
if (!existsSync(RUNTIME_FILE)) {
  throw new Error(
    `${RUNTIME_FILE} is missing — global-setup.ts's setup() should have created it before any e2e spec runs. ` +
      `If you're running a spec file directly (bypassing \`pnpm test:e2e\`), make sure vitest.config.e2e.ts's ` +
      `globalSetup is picked up.`,
  );
}

const runtime: E2eRuntime = JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));

process.env.SUPABASE_URL = runtime.SUPABASE_URL;
process.env.SUPABASE_PUBLISHABLE_KEY = "e2e-test-publishable-key";
process.env.SUPABASE_JWT_SECRET = runtime.SUPABASE_JWT_SECRET;

declare global {
   
  var __KB_E2E__: E2eRuntime;
}
globalThis.__KB_E2E__ = runtime;
