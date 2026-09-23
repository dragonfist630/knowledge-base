import path from "node:path";

import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// The monorepo keeps a single root `.env` (see scripts/setup.mjs and the
// root README). Next.js only auto-loads `.env*` files from this package's
// own directory, so we load the repo root explicitly before anything else
// reads `process.env`. This runs once, early, for both `next dev` and
// `next build`.
const repoRoot = path.resolve(__dirname, "../..");
loadEnvConfig(repoRoot);

const nextConfig: NextConfig = {
  // Traces the minimal set of files a production server needs —
  // including workspace packages like @kb/shared, resolved out of the
  // pnpm workspace rather than assumed to be there — into
  // `.next/standalone/` as a self-contained `server.js` plus only the
  // node_modules it actually touches. Irrelevant to `next dev` (which
  // never reads this option) and to Gate 6's Playwright harness, which
  // also runs dev; it's what apps/web/Dockerfile's production image is
  // built from. See docs/DECISIONS.md D9.13.
  output: "standalone",

  // Next's dev server refuses to start a second instance against the same
  // project directory — even on a different port — because its "another
  // dev server is already running" lock lives in `.next/` and is keyed by
  // directory, not port. Gate 6's Playwright harness (playwright.config.ts)
  // runs its own `next dev` alongside whatever dev server a person already
  // has open on :3000, so it points this at a separate build dir via
  // NEXT_DIST_DIR, leaving the default `.next` (and that lock) untouched.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",

  // Gate 6's Playwright harness (playwright.config.ts) opens the app via
  // 127.0.0.1 rather than localhost, which Next 15+'s dev server treats as
  // a *different* origin from the one the dev server itself considers
  // "local" — it silently blocks that origin's HMR/dev-asset requests
  // unless explicitly allow-listed. Harmless to allow in dev generally
  // (this has no effect on `next build`/`next start`).
  allowedDevOrigins: ["127.0.0.1", "localhost"],

  // Next 16's dev server defaults `experimental.reactDebugChannel` to true:
  // client hydration opens a WebSocket-based "debug channel" and *awaits*
  // it as part of resolving the initial RSC payload (see
  // next/dist/client/app-index.js). If that WebSocket handshake never
  // completes — which happens for every page, in every browser, in this
  // sandbox (verified: a bare `new WebSocket(...)` to the dev server's
  // `/_next/hmr` endpoint fails from Chromium/Playwright while the exact
  // same handshake succeeds via curl, and a trivial unrelated `ws` server
  // works fine from the same browser — so it's specific to Next's dev
  // WS implementation in this environment, not proxies or IndexedDB) —
  // `hydrateRoot()` is never reached and the entire app stays inert
  // (server-rendered HTML only, zero interactivity, no console error).
  // Disabling it removes hydration's dependency on that channel.
  experimental: {
    reactDebugChannel: false,
  },
};

export default nextConfig;
