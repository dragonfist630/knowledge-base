import { baseConfig } from "./base.js";

/** @type {import("eslint").Linter.Config[]} */
export const nestConfig = [
  ...baseConfig,
  {
    rules: {
      // Nest relies on decorators + DI, which reads awkwardly to a couple of
      // the stricter type-checked rules. Relax them here instead of at the
      // call site.
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
];

export default nestConfig;
