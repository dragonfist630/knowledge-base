import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveWebEnv } from "./root-env.mjs";

/**
 * Regression cover for D6.11/D6.12/D6.13. Every case below is a bug that
 * actually shipped, or the behaviour whose loss caused one.
 */

test("NEXT_PUBLIC_* from the root .env reaches next (D6.11)", () => {
  const env = resolveWebEnv({}, {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "anon-key",
    NEXT_PUBLIC_API_URL: "http://localhost:3001",
    NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  });
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, "http://127.0.0.1:54321");
  assert.equal(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "anon-key");
  assert.equal(env.NEXT_PUBLIC_API_URL, "http://localhost:3001");
  assert.equal(env.NEXT_PUBLIC_SITE_URL, "http://localhost:3000");
});

test("PORT from the root .env is apps/api's and must not reach next (D6.12)", () => {
  const env = resolveWebEnv({}, { PORT: "3001" });
  assert.equal(env.PORT, undefined, "next would have bound the API's port");
});

test("NODE_ENV from the root .env must not reach next (D6.13)", () => {
  const env = resolveWebEnv({}, { NODE_ENV: "development" });
  assert.equal(env.NODE_ENV, undefined, "next build would emit a development build");
});

test("apps/api's secrets are not handed to the web process", () => {
  const env = resolveWebEnv({}, {
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    SUPABASE_JWT_SECRET: "jwt-secret",
    OPENAI_API_KEY: "sk-test",
  });
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(env.SUPABASE_JWT_SECRET, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("the real environment always wins over the file", () => {
  const env = resolveWebEnv(
    { NODE_ENV: "production", PORT: "4000", NEXT_PUBLIC_API_URL: "http://from-shell" },
    { NODE_ENV: "development", PORT: "3001", NEXT_PUBLIC_API_URL: "http://from-file" },
  );
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.PORT, "4000");
  assert.equal(env.NEXT_PUBLIC_API_URL, "http://from-shell");
});

test("WEB_PORT in the root .env moves the web app's port", () => {
  assert.equal(resolveWebEnv({}, { WEB_PORT: "3100", PORT: "3001" }).PORT, "3100");
});

test("an explicit PORT still beats WEB_PORT", () => {
  assert.equal(resolveWebEnv({ PORT: "4000" }, { WEB_PORT: "3100" }).PORT, "4000");
});

test("Gate 6's webServer.env keeps precedence over the file", () => {
  const env = resolveWebEnv(
    { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:4110", NEXT_DIST_DIR: ".next-e2e" },
    { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" },
  );
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, "http://127.0.0.1:4110");
  assert.equal(env.NEXT_DIST_DIR, ".next-e2e");
});
