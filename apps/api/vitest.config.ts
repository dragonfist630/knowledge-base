import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // No unit specs yet — real ones start with documents/indexing in
    // Phase 3. Without this, an empty apps/api/src fails `pnpm test` before
    // there's anything to test.
    passWithNoTests: true,
  },
});
