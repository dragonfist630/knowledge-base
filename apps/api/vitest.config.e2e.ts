import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Orchestrates the Gate 3 harness (Postgres + PostgREST + a small
    // reverse proxy + two seeded users) once for the whole suite — no
    // Docker required. See test/e2e/global-setup.ts and
    // docs/DECISIONS.md Phase 3, D3.1.
    globalSetup: ['./test/e2e/global-setup.ts'],
    // Runs per worker, before spec files import AppModule — reads what
    // globalSetup wrote and sets process.env for this worker.
    setupFiles: ['./test/e2e/env.setup.ts'],
    // The harness (one Postgres db, one PostgREST, one proxy) isn't safe
    // for concurrent spec files hitting it at once.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
