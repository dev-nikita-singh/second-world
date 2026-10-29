import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli/main.ts", "perf-worker": "src/engines/performance/worker.ts" },
  format: ["esm", "cjs"],
  target: "node22",
  dts: true,
  clean: true,
  sourcemap: true,
});
