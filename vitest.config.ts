import { defineConfig } from "vitest/config";

// Unit tests run fully parallel. Integration/e2e tests generate real load and measure
// latency, so they run one file at a time to avoid CPU contention skewing measurements.
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary", "html"],
    },
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: [
            "tests/integration/**/*.test.ts",
            "tests/e2e/**/*.test.ts",
            "tests/system/**/*.test.ts",
            "examples/**/*.test.ts",
          ],
          fileParallelism: false,
        },
      },
    ],
  },
});
