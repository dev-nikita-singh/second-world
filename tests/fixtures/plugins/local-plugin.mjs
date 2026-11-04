// Fixture: a plugin loaded by relative path (`plugins: ["./plugins/local-plugin.mjs"]`).
export default {
  name: "local-plugin",
  apiVersion: 1,
  setup(api) {
    api.registerReporter("count", { render: (report) => `${report.results.length}\n` });
  },
};
