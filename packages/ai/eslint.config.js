import { baseConfig } from "@kb/eslint-config";

/**
 * @kb/ai is the one package allowed to import the `openai` SDK directly, but
 * only inside src/openai-compatible/** — that's the sole adapter layer per
 * the provider-agnostic design (see docs/DECISIONS.md). Re-enable the import
 * there; every other file in this package (types, mock models, config,
 * retry, contract tests) stays subject to the repo-wide ban so a future
 * change can't accidentally leak the SDK's shape outside the adapter.
 */
export default [
  ...baseConfig,
  {
    files: ["src/openai-compatible/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
];
