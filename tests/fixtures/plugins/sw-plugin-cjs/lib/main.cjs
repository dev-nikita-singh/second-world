// Fixture: a CommonJS plugin exporting a factory `(options) => plugin` (namespace "cjs").
module.exports = (options) => ({
  name: "sw-plugin-cjs",
  version: "0.4.0",
  apiVersion: "^1",
  setup(api) {
    api.registerReporter(
      "lines",
      (report) => `${options.prefix ?? ""}${report.verdict.passed ? "passed" : "failed"}\n`,
    );
  },
});
