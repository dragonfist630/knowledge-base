import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Gate 6's Playwright harness builds into a separate dir so its own
    // `next dev` doesn't collide with one already running against :3000 —
    // see next.config.ts and playwright.config.ts. Same generated,
    // not-meant-to-be-linted contents as `.next/**`.
    ".next-e2e/**",
  ]),
]);

export default eslintConfig;
