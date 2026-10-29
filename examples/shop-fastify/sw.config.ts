/**
 * SECOND WORLD config for shop-fastify (docs/08-configuration.md). Plain object so it
 * type-checks without a built package; real projects use `defineConfig` from "second-world".
 */
export default {
  $schemaVersion: 1,
  project: { root: ".", name: "shop-fastify" },
  environment: "local",
  targets: {
    api: { url: "http://127.0.0.1:3001", health: "/healthz" },
    payments: { url: "http://127.0.0.1:4010", role: "dependency" },
  },
  safety: { allowHosts: ["127.0.0.1", "localhost"], maxRps: 500, maxConcurrency: 100, allowMutations: true },
  auth: {
    user: { type: "bearer", token: "alice-token" },
    other: { type: "bearer", token: "bob-token" },
    admin: { type: "bearer", token: "admin-token" },
  },
  hooks: { reset: { http: { method: "POST", url: "http://127.0.0.1:3001/__test/reset" } } },
  performance: {
    target: "api",
    model: "closed",
    vus: 10,
    duration: "15s",
    seed: 42,
    scenarios: [
      { name: "page", weight: 5, steps: [{ method: "GET", path: "/products?page={{rand 1 4}}&limit=10", expect: { status: 200 } }] },
      { name: "search", weight: 5, steps: [{ method: "GET", path: "/products/search?q=red", expect: { status: 200 } }] },
    ],
    thresholds: { "http.p95": "< 150ms", "http.error_rate": "< 1%" },
  },
  bugs: { contract: "./openapi.yaml" },
};
