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
      {
        name: "page",
        weight: 5,
        steps: [{ method: "GET", path: "/products?page={{rand 1 4}}&limit=10", expect: { status: 200 } }],
      },
      {
        name: "search",
        weight: 5,
        steps: [{ method: "GET", path: "/products/search?q=red", expect: { status: 200 } }],
      },
    ],
    thresholds: { "http.p95": "< 150ms", "http.error_rate": "< 1%" },
  },
  bugs: {
    contract: "./openapi.yaml",
    // /products/search is the seeded slow full scan (~40 queries per call): keep property runs low.
    propertyRuns: 8,
    concurrency: [
      {
        // Precision check: the stock decrement is atomic here (correctByDesign stock-atomic),
        // so this mixed history of orders and stock reads must stay linearizable.
        name: "last item: orders vs stock reads",
        operation: "POST /orders",
        burst: 5,
        role: "user",
        body: { productId: 40, qty: 1 },
        mix: [
          {
            operation: "GET /products/{id}",
            pathParams: { id: 40 },
            as: "read",
            pointer: "/stock",
            phase: "before",
          },
          {
            operation: "GET /products/{id}",
            pathParams: { id: 40 },
            as: "read",
            pointer: "/stock",
            count: 2,
          },
          {
            operation: "GET /products/{id}",
            pathParams: { id: 40 },
            as: "read",
            pointer: "/stock",
            phase: "after",
          },
        ],
        invariant: { kind: "linearizable", model: "stock" },
      },
      {
        // One logical order retried concurrently: sequential repeats are replayed, but the
        // lookup -> await -> insert is not atomic, so concurrent duplicates each create an order.
        name: "same Idempotency-Key, concurrent",
        operation: "POST /orders",
        burst: 5,
        role: "user",
        body: { productId: 1, qty: 1 },
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
          body: '{"productId":{{rand 1 39}},"qty":1}',
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
    invariants: [
      // GET /orders returns each order's Idempotency-Key: at most one order per key.
      {
        type: "no-duplicates",
        name: "one-order-per-key",
        collection: "GET /orders",
        headersFrom: "orders",
        key: "idempotencyKey",
      },
      {
        type: "count-matches",
        name: "orders-per-operation",
        collection: "GET /orders",
        headersFrom: "orders",
      },
    ],
  },
};
