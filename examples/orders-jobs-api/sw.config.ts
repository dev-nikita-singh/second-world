/**
 * SECOND WORLD config for the orders-jobs-api example (docs/08-configuration.md).
 *
 * In a real project you would write:
 *   import { defineConfig } from "second-world";
 *   export default defineConfig({ ... });
 * A plain object is exported here so the example type-checks without a built package.
 *
 * Run (from the repo root, with the provider and the app started — see README.md):
 *   npx tsx src/cli/main.ts --config examples/orders-jobs-api/sw.config.ts bugs
 */
export default {
  $schemaVersion: 1,
  project: { root: ".", name: "orders-jobs-api" },
  environment: "local",
  targets: {
    api: { url: "http://127.0.0.1:3200", health: "/healthz" },
    payments: { url: "http://127.0.0.1:4020", role: "dependency" },
  },
  safety: {
    allowHosts: ["127.0.0.1", "localhost"],
    maxRps: 500,
    maxConcurrency: 200,
    maxDuration: "5m",
    allowMutations: true,
    redact: { headers: ["authorization", "cookie"] },
  },
  // Demo accounts seeded by the app (src/db.ts). alice owns order 1, bob owns order 2.
  auth: {
    alice: { type: "bearer", token: "alice-token" },
    bob: { type: "bearer", token: "bob-token" },
  },
  hooks: {
    reset: { http: { method: "POST", url: "http://127.0.0.1:3200/__test/reset" } },
  },
  performance: {
    target: "api",
    model: "open",
    rate: 10,
    duration: "15s",
    warmup: "2s",
    timeout: "8s",
    seed: 42,
    auth: "alice",
    scenarios: [
      {
        name: "browse",
        weight: 5,
        steps: [
          { method: "GET", path: "/orders?limit=10", expect: { status: 200 } },
          { method: "GET", path: "/orders/1", expect: { status: 200 } },
          { method: "GET", path: "/orders/1/payment", expect: { status: 200 } },
        ],
      },
      {
        // Checkout: place an order, then wait (long-poll, ≤ 5 s) for its payment job.
        name: "checkout",
        weight: 5,
        steps: [
          {
            method: "POST",
            path: "/orders",
            json: { sku: "TEA-001", quantity: 1, shippingAddress: "1 Main St" },
            expect: { status: 201 },
            extract: { job: "$.paymentJobId" },
          },
          { method: "GET", path: "/jobs/{{job}}?wait=5000", expect: { status: 200 } },
        ],
      },
    ],
    thresholds: {
      "http.error_rate": "< 1%",
      // Payment-job SLO: a job finishes within 2 s of the order (the long-poll returns when it does).
      "endpoint.GET /jobs/{{job}}.p95": "< 2000ms",
    },
  },
  stress: {
    // Half of the iterations are checkouts. The payment workers (4 x ~300 ms provider latency
    // ≈ 13 jobs/s) are the bottleneck: at 48 rps (24 checkouts/s) a bounded queue sheds load (503)
    // and keeps job waits bounded; an unbounded one keeps accepting orders while every job waits longer.
    mode: "step",
    // Arrival rate (open model). Stress inherits performance.model/rate when unset; explicit here for clarity.
    loadType: "rate",
    stages: [4, 12, 48],
    hold: "6s",
    stopWhen: { errorRate: 0.2 },
  },
  architecture: {
    include: ["src/**/*.ts"],
    exclude: ["**/*.test.ts"],
  },
  bugs: {
    contract: "./openapi.yaml",
    // Known-good values: order 1 (alice) was paid with charge ch_seed_1 for 2500 cents.
    values: { orderId: [1], chargeId: ["ch_seed_1"], amount: [2500] },
    stateful: {
      resources: [
        {
          name: "order",
          create: "POST /orders",
          read: "GET /orders/{id}",
          update: "PUT /orders/{id}",
          delete: "DELETE /orders/{id}",
          idPointer: "/id",
          body: { sku: "MUG-002", quantity: 1, shippingAddress: "1 Probe St", note: "sw probe" },
        },
      ],
    },
    // Read-your-writes on the order cache: read order 1 (fills the cache), replace its note twice
    // at once, then read it again. A register must return the last written note afterwards.
    concurrency: [
      {
        name: "order note: read, concurrent updates, read again",
        operation: "PUT /orders/{id}",
        pathParams: { id: 1 },
        role: "alice",
        burst: 2,
        as: "write",
        pointer: "/note",
        body: { shippingAddress: "1 Main St", note: "updated by sw" },
        mix: [
          {
            operation: "GET /orders/{id}",
            pathParams: { id: 1 },
            role: "alice",
            as: "read",
            pointer: "/note",
            phase: "before",
          },
          {
            operation: "GET /orders/{id}",
            pathParams: { id: 1 },
            role: "alice",
            as: "read",
            pointer: "/note",
            phase: "after",
          },
        ],
        invariant: { kind: "linearizable", model: "register" },
      },
    ],
  },
  agent: {
    allowDestructive: true,
    budget: { maxIterations: 120, maxRequests: 1500, maxDuration: "90s" },
    slowMs: 3000,
  },
  reliability: {
    // The app must call the provider through the fault proxy: start it with
    // PROVIDER_URL=http://127.0.0.1:4021 (the proxy forwards to targets.payments).
    dependency: "payments",
    dependencies: { payments: { injector: "builtin", upstream: "payments", proxyListen: 4021 } },
    workload: {
      rate: 10,
      timeout: "6s",
      routes: [
        {
          // Placing an order does not call the provider in the request (the payment job does).
          name: "orders",
          method: "POST",
          path: "/orders",
          auth: "alice",
          body: '{"sku":"TEA-001","quantity":1,"shippingAddress":"1 Main St"}',
          dependsOn: [],
        },
        {
          // Reconciles the payment with the provider synchronously.
          name: "refresh",
          method: "GET",
          path: "/orders/1/payment?refresh=true",
          auth: "alice",
          dependsOn: ["payments"],
        },
      ],
    },
    steady: "3s",
    duration: "5s",
    recovery: "3s",
    repeat: 1,
    // GET …/payment?refresh=true must give up on a hung provider well within the clients' 6 s.
    maxOutboundBudget: "2s",
  },
};
