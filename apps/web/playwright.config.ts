import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

import {
  E2E_ANON_KEY,
  E2E_API_PORT,
  E2E_API_URL,
  E2E_GATEWAY_URL,
  E2E_JWT_SECRET,
  E2E_WEB_PORT,
  E2E_WEB_URL,
} from "./e2e/support/constants";

/**
 * Gate 6: a real Chromium driven through the real apps/web dev server,
 * talking to a real apps/api + real PostgREST + this harness's
 * GoTrue-compatible auth-gateway shim (see e2e/global-setup.ts and
 * e2e/support/auth-gateway.ts) — no mocked fetches anywhere in the stack.
 * The only thing standing in for a hosted Supabase project is the shim; the
 * chat/embedding models are the repo's existing MockChatModel/MockEmbedder
 * (AI_CHAT_PROVIDER/AI_EMBEDDING_PROVIDER default to "mock" — see
 * packages/ai/src/config.ts), same as every other gate in this project.
 *
 * `webServer.env` is evaluated when this config file loads, which is
 * *before* globalSetup runs (see global-setup.ts's doc comment for the
 * proof) — so every value referenced here has to be a fixed constant from
 * support/constants.ts, never something globalSetup computes at runtime.
 * That's why the gateway/API/web ports and the JWT secret are all
 * hard-coded defaults in constants.ts rather than dynamically allocated.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",

  use: {
    baseURL: E2E_WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // This sandbox preinstalls a fixed Chromium build outside
        // @playwright/test's own version-pinned download cache (no
        // outbound access to download a matching one at test time) — see
        // docs/DECISIONS.md Phase 6. A real CI/dev machine with normal
        // network access doesn't need this; `playwright install chromium`
        // there makes this override unnecessary (launchOptions.executablePath
        // simply isn't set), so this is guarded behind the same env marker.
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH
          ? { launchOptions: { executablePath: `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium` } }
          : {}),
      },
    },
  ],

  webServer: [
    {
      // Already built by the full pipeline's `build` task — running the
      // compiled output is both faster and closer to how this app actually
      // ships than `nest start --watch` would be for a one-shot test run.
      command: "node dist/main.js",
      cwd: path.join(REPO_ROOT, "apps", "api"),
      url: `${E2E_API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        ...process.env,
        PORT: String(E2E_API_PORT),
        WEB_ORIGIN: E2E_WEB_URL,
        SUPABASE_URL: E2E_GATEWAY_URL,
        SUPABASE_PUBLISHABLE_KEY: E2E_ANON_KEY,
        SUPABASE_JWT_SECRET: E2E_JWT_SECRET,
        AI_CHAT_PROVIDER: "mock",
        AI_EMBEDDING_PROVIDER: "mock",
      },
    },
    {
      command: `next dev -p ${E2E_WEB_PORT}`,
      cwd: __dirname,
      url: E2E_WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...process.env,
        PORT: String(E2E_WEB_PORT),
        // A separate build dir so this doesn't collide with (or refuse to
        // start next to) a dev server someone already has running against
        // this same project directory on :3000 — see next.config.ts.
        NEXT_DIST_DIR: ".next-e2e",
        NEXT_PUBLIC_API_URL: E2E_API_URL,
        NEXT_PUBLIC_SUPABASE_URL: E2E_GATEWAY_URL,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: E2E_ANON_KEY,
        NEXT_PUBLIC_SITE_URL: E2E_WEB_URL,
      },
    },
  ],
});
