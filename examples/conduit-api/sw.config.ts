/**
 * SECOND WORLD config for the conduit-api example (docs/08-configuration.md).
 *
 * In a real project you would write:
 *   import { defineConfig } from "second-world";
 *   export default defineConfig({ ... });
 * A plain object is exported here so the example type-checks without a built package.
 *
 * Run (from the repo root, with the app started — see README.md):
 *   npx tsx src/cli/main.ts --config examples/conduit-api/sw.config.ts bugs
 */
export default {
  $schemaVersion: 1,
  project: { root: ".", name: "conduit-api" },
  environment: "local",
  targets: {
    api: { url: "http://127.0.0.1:3100", health: "/healthz" },
  },
  safety: {
    allowHosts: ["127.0.0.1", "localhost"],
    maxRps: 500,
    maxConcurrency: 100,
    maxDuration: "5m",
    allowMutations: true,
    redact: { headers: ["authorization", "cookie"], bodyPaths: ["$..password", "$..token"] },
  },
  // Demo accounts seeded by the app (src/seed.ts). alice = resource owner, bob = the other account.
  auth: {
    alice: { type: "bearer", token: "alice-token" },
    bob: { type: "bearer", token: "bob-token" },
    carol: { type: "bearer", token: "carol-token" },
    dave: { type: "bearer", token: "dave-token" },
    erin: { type: "bearer", token: "erin-token" },
    frank: { type: "bearer", token: "frank-token" },
  },
  hooks: {
    reset: { http: { method: "POST", url: "http://127.0.0.1:3100/__test/reset" } },
  },
  performance: {
    target: "api",
    model: "open",
    rate: 20,
    duration: "20s",
    warmup: "2s",
    timeout: "5s",
    seed: 42,
    scenarios: [
      {
        name: "list",
        weight: 4,
        steps: [{ method: "GET", path: "/api/articles?limit=10", expect: { status: 200 } }],
      },
      {
        name: "read",
        weight: 4,
        steps: [
          { method: "GET", path: "/api/articles/welcome-to-conduit", expect: { status: 200 } },
          { method: "GET", path: "/api/articles/welcome-to-conduit/comments", expect: { status: 200 } },
        ],
      },
      {
        name: "feed",
        weight: 2,
        auth: "alice",
        steps: [{ method: "GET", path: "/api/articles/feed?limit=10", expect: { status: 200 } }],
      },
    ],
    thresholds: {
      "http.p95": "< 1000ms",
      "http.error_rate": "< 1%",
    },
  },
  stress: {
    mode: "step",
    stages: [5, 10, 20],
    hold: "5s",
    stopWhen: { errorRate: 0.05 },
  },
  architecture: {
    include: ["src/**/*.ts"],
    exclude: ["**/*.test.ts"],
  },
  bugs: {
    contract: "./openapi.yaml",
    // Known-good path values: the Bug Hunter harvests only `id` fields, and Conduit addresses
    // articles by slug. (Not `username`: it would also fill the registration body → 409.)
    values: { slug: ["welcome-to-conduit"] },
    // The resource the BOLA / round-trip checks use: articles are addressed by slug.
    stateful: {
      resources: [
        {
          name: "article",
          create: "POST /api/articles",
          read: "GET /api/articles/{slug}",
          update: "PUT /api/articles/{slug}",
          delete: "DELETE /api/articles/{slug}",
          idPointer: "/article/slug",
          body: { article: { title: "SW probe", description: "probe", body: "probe body", tagList: ["sw"] } },
        },
      ],
    },
    // Developer-defined invariant: a page never has more than `limit` articles.
    invariants: [
      {
        module: "./invariants/page-size.mjs",
        name: "page-size",
        operations: ["GET /api/articles", "GET /api/articles/feed"],
      },
    ],
    concurrency: [
      {
        // Five different users favorite the same article at once, between reads of its counter.
        // favoritesCount must behave like a counter that each successful favorite increments once.
        name: "favorites counter: concurrent favorites by five users",
        operation: "GET /api/articles/{slug}",
        pathParams: { slug: "welcome-to-conduit" },
        burst: 2,
        as: "read",
        pointer: "/article/favoritesCount",
        mix: [
          {
            operation: "GET /api/articles/{slug}",
            pathParams: { slug: "welcome-to-conduit" },
            as: "read",
            pointer: "/article/favoritesCount",
            phase: "before",
          },
          {
            operation: "POST /api/articles/{slug}/favorite",
            pathParams: { slug: "welcome-to-conduit" },
            role: "bob",
            as: "inc",
          },
          {
            operation: "POST /api/articles/{slug}/favorite",
            pathParams: { slug: "welcome-to-conduit" },
            role: "carol",
            as: "inc",
          },
          {
            operation: "POST /api/articles/{slug}/favorite",
            pathParams: { slug: "welcome-to-conduit" },
            role: "dave",
            as: "inc",
          },
          {
            operation: "POST /api/articles/{slug}/favorite",
            pathParams: { slug: "welcome-to-conduit" },
            role: "erin",
            as: "inc",
          },
          {
            operation: "POST /api/articles/{slug}/favorite",
            pathParams: { slug: "welcome-to-conduit" },
            role: "frank",
            as: "inc",
          },
          {
            operation: "GET /api/articles/{slug}",
            pathParams: { slug: "welcome-to-conduit" },
            as: "read",
            pointer: "/article/favoritesCount",
            phase: "after",
          },
        ],
        invariant: { kind: "linearizable", model: "counter" },
      },
    ],
  },
  agent: {
    // DELETE is destructive for the agent: allowed here because the reset hook restores the seed data.
    allowDestructive: true,
    budget: { maxIterations: 120, maxRequests: 1500, maxDuration: "90s" },
    slowMs: 1500,
  },
  reliability: {
    // conduit-api has no outbound dependency (SQLite is in-process), so the faults go on the
    // client → API path: the built-in proxy listens on 3101 and forwards to the API on 3100.
    target: "http://127.0.0.1:3101",
    dependency: "edge",
    dependencies: { edge: { injector: "builtin", upstream: "api", proxyListen: 3101 } },
    params: { latency: "300ms" },
    workload: {
      rate: 8,
      timeout: "2s",
      routes: [
        { name: "list", method: "GET", path: "/api/articles?limit=5", dependsOn: ["edge"] },
        { name: "read", method: "GET", path: "/api/articles/welcome-to-conduit", dependsOn: ["edge"] },
      ],
    },
    steady: "2s",
    duration: "4s",
    recovery: "3s",
    repeat: 1,
  },
};
