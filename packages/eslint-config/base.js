// Shared flat ESLint config for the monorepo.
// Every app/package extends this and layers its own framework rules on top.
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/** @type {import("eslint").Linter.Config[]} */
export const baseConfig = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "openai",
              message:
                "Import the provider-agnostic ChatModel/EmbeddingModel from @kb/ai instead. " +
                "Only packages/ai/src/openai-compatible/** is allowed to touch the `openai` SDK directly " +
                "(see that package's eslint.config.js override) — every other caller should go through the " +
                "abstraction so the app never depends on one vendor's SDK shape.",
            },
          ],
        },
      ],
      // `no-restricted-imports`'s `paths` option only catches static
      // `import ... from "openai"` / `export ... from "openai"` — it does
      // NOT catch `import("openai")` (dynamic import) or `require("openai")`,
      // both of which would also dodge Gate 2's `grep "from 'openai'"`
      // check since neither uses the `from` keyword. Block those forms
      // explicitly via AST selectors so there's no unenforced backdoor.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value='openai']",
          message:
            "Dynamic import of 'openai' is restricted, same as a static import — see the " +
            "no-restricted-imports message for 'openai' above.",
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value='openai']",
          message:
            "require('openai') is restricted, same as a static import — see the " +
            "no-restricted-imports message for 'openai' above.",
        },
      ],
    },
  },
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/*.config.*",
    ],
  },
  eslintConfigPrettier,
];

export default baseConfig;
