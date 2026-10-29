/**
 * SECOND WORLD config for the shop-express example (docs/08-configuration.md).
 *
 * In a real project you would write:
 *   import { defineConfig } from "second-world";
 *   export default defineConfig({ ... });
 * A plain object is exported here so the example type-checks without a built package.
 *
 * Run (from the repo root, with the shop and payments-fake started — see README.md):
 *   npx tsx src/cli/main.ts perf --config examples/shop-express/sw.config.ts
 */
export default {
  $schemaVersion: 1,
  project: { root: ".", name: "shop-express" },
  environment: "local",
  targets: {
    api: { url: "http://127.0.0.1:3000", health: "/healthz" },
    payments: { url: "http://127.0.0.1:4010", role: "dependency" },
  },
  safety: {
    allowHosts: ["127.0.0.1", "localhost"],
    maxRps: 500,
    maxConcurrency: 100,
    maxDuration: "5m",
    allowMutations: true,
    redact: { headers: ["authorization", "cookie"], bodyPaths: ["$.password", "$..token"] },
  },
  auth: {
    user: { type: "bearer", token: "alice-token" },
    other: { type: "bearer", token: "bob-token" },
    admin: { type: "bearer", token: "admin-token" },
  },
  hooks: {
    reset: { http: { method: "POST", url: "http://127.0.0.1:3000/__test/reset" } },
  },
  performance: {
    target: "api",
    model: "open",
    rate: 50,
    duration: "20s",
    warmup: "2s",
    timeout: "5s",
    seed: 42,
    scenarios: [
      {
        name: "browse",
        weight: 8,
        steps: [
          { method: "GET", path: "/products", expect: { status: 200 } },
          { method: "GET", path: "/products/{{rand 1 20}}", expect: { status: 200 } },
        ],
      },
      {
        name: "browse-with-reviews",
        weight: 1,
        steps: [{ method: "GET", path: "/products?include=reviews", expect: { status: 200 } }],
      },
      {
        name: "checkout",
        weight: 1,
        auth: "user",
        steps: [
          {
            method: "POST",
            path: "/orders",
            json: { items: [{ productId: 1, qty: 1 }] },
            headers: { "Idempotency-Key": "{{uuid}}" },
            expect: { status: [201, 409] },
          },
        ],
      },
    ],
    thresholds: {
      "http.p95": "< 200ms",
      "http.error_rate": "< 1%",
    },
  },
  architecture: {
    include: ["src/**/*.ts"],
    exclude: ["**/*.test.ts"],
  },
  bugs: {
    contract: "./openapi.yaml",
    // Mixed-operation race check: orders for the last item interleaved with stock reads.
    // The history must be explainable by one-at-a-time execution (linearizable stock model).
    concurrency: [
      {
        name: "last item: orders vs stock reads",
        operation: "POST /orders",
        burst: 5,
        role: "user",
        body: { items: [{ productId: 20, qty: 1 }] },
        mix: [
          {
            operation: "GET /products/{id}",
            pathParams: { id: 20 },
            as: "read",
            pointer: "/stock",
            phase: "before",
          },
          {
            operation: "GET /products/{id}",
            pathParams: { id: 20 },
            as: "read",
            pointer: "/stock",
            count: 2,
          },
          {
            operation: "GET /products/{id}",
            pathParams: { id: 20 },
            as: "read",
            pointer: "/stock",
            phase: "after",
          },
        ],
        invariant: { kind: "linearizable", model: "stock" },
      },
      {
        // One logical order retried concurrently: every request carries the same Idempotency-Key,
        // so all successful responses must be the same order.
        name: "same Idempotency-Key, concurrent",
        operation: "POST /orders",
        burst: 5,
        role: "user",
        body: { items: [{ productId: 1, qty: 1 }] },
        sameIdempotencyKey: true,
        invariant: { kind: "same-response", pointer: "/id" },
      },
    ],
  },
  reliability: {
    // The shop must call payments through the fault proxy: start it with
    // PAYMENTS_URL=http://127.0.0.1:4011 (the proxy forwards to targets.payments).
    dependency: "payments",
    dependencies: { payments: { injector: "builtin", upstream: "payments", proxyListen: 4011 } },
    // dependency-latency: payments answers after 1.5 s (below the 2 s per-attempt timeout of shop-fastify).
    params: { latency: "1500ms" },
    workload: {
      rate: 8,
      // Clients give up after 1 s and retry the same logical order with the same Idempotency-Key.
      timeout: "1s",
      routes: [
        {
          name: "orders",
          method: "POST",
          path: "/orders",
          auth: "user",
          body: '{"items":[{"productId":{{rand 1 19}},"qty":1}]}',
          dependsOn: ["payments"],
          idempotency: {
            header: "Idempotency-Key",
            retries: 2,
            backoff: "50ms",
            retryOn: ["transport", "timeout"],
          },
        },
      ],
    },
    steady: "2s",
    duration: "5s",
    recovery: "3s",
    // A detector hit in both repetitions is a reproduced defect.
    repeat: 2,
    // The shop should give up on a hung payments call well within the clients' 1 s timeout:
    // dependency-timeout reports outbound-no-timeout when requests wait longer than this budget.
    maxOutboundBudget: "800ms",
    invariants: [
      // Orders created must match the logical orders that succeeded (retries must not add orders).
      {
        type: "count-matches",
        name: "orders-per-operation",
        collection: "GET /orders",
        headersFrom: "orders",
      },
    ],
  },
};
