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
  /* config options here */
};

export default nextConfig;
