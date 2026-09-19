import { defineConfig } from "tsup";

export default defineConfig((options) => ({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  // Only wipe dist for a one-shot `build` — in `--watch` mode (`turbo dev`),
  // tsup re-runs this config on every incremental rebuild, and a `clean`
  // step briefly deletes dist (including index.d.ts) before regenerating
  // it. Any consumer compiling at that exact instant (apps/api's NestJS
  // watch compiler, most often) sees a missing/incomplete package and
  // fails with a stale-looking "no exported member" / "could not find a
  // declaration file" error that clears itself a moment later. See
  // docs/DECISIONS.md Phase 6, D6.10.
  clean: !options.watch,
  target: "es2022",
}));
