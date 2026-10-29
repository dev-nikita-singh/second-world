import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../src/core/clock.js";
import {
  buildModel,
  diffModels,
  dotEscape,
  loadModelSnapshot,
  type ModelData,
  mermaidEscape,
  modelEngine,
  modelToDot,
  modelToMermaid,
  parseModelInput,
  saveModelSnapshot,
  toCanonicalJson,
} from "../../../src/engines/model/index.js";
import { withTmpDir } from "../../helpers/tmp.js";

/** Minimal ArchitectureData-shaped stub (what fromArchitecture reads). */
const arch = {
  project: { root: ".", files: 3, workspaces: [], frameworks: ["express"] },
  components: [
    { id: "route:GET /items/:id", kind: "route", name: "GET /items/:id", file: "src/r.ts", line: 3 },
    { id: "route:POST /items", kind: "route", name: "POST /items", file: "src/r.ts", line: 9 },
    { id: "fn:src/r.ts#GET /items/:id", kind: "handler", name: "GET /items/:id", file: "src/r.ts", line: 3 },
    { id: "fn:src/r.ts#POST /items", kind: "handler", name: "POST /items", file: "src/r.ts", line: 9 },
    { id: "fn:src/repo.ts#Repo.get", kind: "repository", name: "Repo.get", file: "src/repo.ts", line: 1 },
    { id: "datastore:postgres", kind: "datastore", name: "postgres", library: "pg" },
    { id: "external:billing", kind: "external", name: "billing", library: "fetch", heuristic: true },
  ],
  edges: [
    {
      from: "route:GET /items/:id",
      to: "fn:src/r.ts#GET /items/:id",
      kind: "calls",
      evidence: [{ file: "src/r.ts", line: 3, column: 1, extractor: "framework/express", confidence: 0.95 }],
    },
    {
      from: "fn:src/r.ts#GET /items/:id",
      to: "fn:src/repo.ts#Repo.get",
      kind: "calls",
      evidence: [{ file: "src/r.ts", line: 4, column: 1, extractor: "core/calls", confidence: 0.9 }],
    },
    {
      from: "fn:src/repo.ts#Repo.get",
      to: "datastore:postgres",
      kind: "reads",
      evidence: [{ file: "src/repo.ts", line: 2, column: 1, extractor: "clients/db", confidence: 0.9 }],
    },
    {
      from: "route:POST /items",
      to: "fn:src/r.ts#POST /items",
      kind: "calls",
      evidence: [{ file: "src/r.ts", line: 9, column: 1, extractor: "framework/express", confidence: 0.95 }],
    },
    {
      from: "fn:src/r.ts#POST /items",
      to: "datastore:postgres",
      kind: "writes",
      evidence: [{ file: "src/r.ts", line: 10, column: 1, extractor: "clients/db", confidence: 0.9 }],
    },
    {
      from: "fn:src/r.ts#POST /items",
      to: "external:billing",
      kind: "calls",
      evidence: [
        {
          file: "src/r.ts",
          line: 11,
          column: 1,
          extractor: "clients/http",
          confidence: 0.5,
          heuristic: true,
        },
      ],
    },
  ],
  routes: [
    {
      id: "route:GET /items/:id",
      framework: "express",
      method: "GET",
      path: "/items/:id",
      middlewares: [],
      auth: false,
      file: "src/r.ts",
      line: 3,
    },
    {
      id: "route:POST /items",
      framework: "express",
      method: "POST",
      path: "/items",
      middlewares: [],
      auth: true,
      file: "src/r.ts",
      line: 9,
    },
  ],
};

const openapi = {
  openapi: "3.1.0",
  info: { title: "items", version: "1" },
  servers: [{ url: "http://localhost:8080" }],
  paths: {
    "/items/{itemId}": { get: { responses: { "200": { description: "ok" } } } },
    "/items": { post: { responses: { "201": { description: "ok" } } } },
  },
};

const perf = {
  runId: "perf1",
  data: {
    target: "http://127.0.0.1:8080",
    window: { startedAt: "2026-10-29T00:00:00.000Z", endedAt: "2026-10-29T00:00:10.000Z" },
    endpoints: [
      {
        method: "GET",
        path: "/items/{{rand 1 9}}",
        requests: 900,
        rps: 90,
        errorRate: 0.01,
        latency: { corrected: { p95: 12.5 } },
      },
      {
        method: "POST",
        path: "/items",
        requests: 100,
        rps: 10,
        errorRate: 0,
        latency: { corrected: { p95: 40 } },
      },
    ],
  },
};

async function build(extra: Record<string, unknown> = {}) {
  const r = await buildModel(
    { serviceName: "items-api", architectureData: arch, openapi, ...extra },
    { clock: createFakeClock(Date.parse("2026-10-29T12:00:00Z")) },
  );
  return r;
}

describe("buildModel (stub sources)", () => {
  it("merges static + OpenAPI routes, collapses internal functions, attaches perf metrics", async () => {
    const r = await build({ performance: [perf] });
    expect(r.status).toBe("passed");
    const d = r.data as ModelData;
    expect(d.primaryService).toBe("service:items-api");
    const ids = d.nodes.map((n) => n.id);
    expect(ids).toEqual([
      "datastore:postgres",
      "external:billing",
      "route:items-api:GET /items/{itemId}",
      "route:items-api:POST /items",
      "service:items-api",
    ]);
    const get = d.nodes.find((n) => n.id === "route:items-api:GET /items/{itemId}");
    expect(get?.observed).toMatchObject({ rps: 90, p95Ms: 12.5, errorRate: 0.01, source: "performance" });
    expect(new Set(get?.evidence.map((e) => e.source))).toEqual(
      new Set(["static", "openapi", "performance"]),
    );
    expect(get?.service).toBe("service:items-api");
    expect(d.edges.map((e) => e.id)).toEqual([
      "route:items-api:GET /items/{itemId}->datastore:postgres:reads",
      "route:items-api:POST /items->datastore:postgres:writes",
      "route:items-api:POST /items->external:billing:calls",
      "service:items-api->datastore:postgres:reads",
      "service:items-api->datastore:postgres:writes",
      "service:items-api->external:billing:calls",
    ]);
    // Heuristic static evidence → 0.5; the static edge keeps file:line provenance.
    const bill = d.edges.find((e) => e.id === "route:items-api:POST /items->external:billing:calls");
    expect(bill?.confidence).toBe(0.5);
    expect(bill?.evidence[0]).toMatchObject({ source: "static-heuristic", origin: "src/r.ts", line: 11 });
    // Primary service merged with perf target (localhost ≡ 127.0.0.1).
    expect(
      d.merges.some(
        (m) => m.node === "service:items-api" && m.rule === "host-port" && m.detail === "127.0.0.1:8080",
      ),
    ).toBe(true);
    expect(d.coverage.sources).toMatchObject({
      static: true,
      openapi: true,
      performance: true,
      traces: false,
    });
    expect(d.coverage.banner).toContain("static analysis ✓");
    expect(d.coverage.banner).toContain("runtime traces ✗");
    expect(r.limitations.map((l) => l.code)).toEqual(
      expect.arrayContaining(["MODEL_NO_TRACES", "MODEL_STATIC_COLLAPSED"]),
    );
    expect(r.limitations.map((l) => l.code)).not.toContain("MODEL_OTLP_PROTOBUF");
    // Non-enumerable graph
    expect(Object.keys(d)).not.toContain("graph");
    expect(r.data?.graph.impactOf("postgres").map((x) => x.id)).toEqual(
      expect.arrayContaining([
        "route:items-api:GET /items/{itemId}",
        "route:items-api:POST /items",
        "service:items-api",
      ]),
    );
  });

  it("detail: full keeps handlers and internal functions", async () => {
    const r = await build({ detail: "full" });
    const kinds = new Set(r.data?.nodes.map((n) => n.kind));
    expect(kinds.has("handler")).toBe(true);
    expect(kinds.has("module")).toBe(true);
  });

  it("rejects the removed AI hypotheses input; low-confidence entities are drawn dotted", async () => {
    await expect(
      build({ hypotheses: [{ type: "node", name: "rabbitmq", kind: "queue", statement: "x" }] }),
    ).rejects.toThrow();
    const d = (await build()).data as ModelData;
    expect(Object.keys(d.coverage.sources).sort()).toEqual([
      "config",
      "experiments",
      "metrics",
      "openapi",
      "performance",
      "static",
      "traces",
    ]);
    expect(d.coverage.banner).not.toMatch(/\bAI\b/);
    expect(Object.keys(d.stats)).not.toContain("hypotheses");
    for (const n of d.nodes) {
      expect(n).not.toHaveProperty("hypothesis");
      const allowed = ["source", "confidence", "origin", "detail", "line", "count", "traceIds"];
      for (const e of n.evidence) for (const k of Object.keys(e)) expect(allowed).toContain(k);
    }
    for (const e of d.edges) expect(e).not.toHaveProperty("hypothesis");
    const billing = d.nodes.find((n) => n.id === "external:billing");
    expect(billing?.confidence).toBe(0.5);
    expect(modelToDot(d)).toContain('style="dotted"');
  });

  it("attaches findings as failure modes and reliability experiments as evidence", async () => {
    const r = await build({
      findings: [
        {
          findings: [
            {
              engine: "bugs",
              ruleId: "bugs/server-error",
              title: "500 on GET",
              severity: "high",
              classification: "reproduced-defect",
              affected: ["GET /items/{id}"],
              fingerprint: "f1",
            },
          ],
        },
        {
          engine: "reliability",
          ruleId: "reliability/no-circuit-breaker",
          title: "no breaker",
          affected: [],
          fingerprint: "f2",
        },
        {
          engine: "agent",
          ruleId: "x",
          title: "guess",
          classification: "hypothesis",
          affected: ["POST /items"],
        },
      ],
      reliability: [
        {
          runId: "rel1",
          data: {
            schema: 1,
            dependency: "billing",
            scenario: "dependency-latency",
            verdict: "violated",
            reproduced: [{ ruleId: "reliability/retry-storm", hits: 2, runs: 2 }],
          },
        },
      ],
    });
    const d = r.data as ModelData;
    const get = d.nodes.find((n) => n.id === "route:items-api:GET /items/{itemId}");
    expect(get?.failureModes).toEqual([
      expect.objectContaining({ id: "bugs/server-error", source: "bugs", severity: "high" }),
    ]);
    expect(d.nodes.find((n) => n.id === "route:items-api:POST /items")?.failureModes).toBeUndefined();
    const svc = d.nodes.find((n) => n.id === "service:items-api");
    expect(svc?.failureModes?.map((f) => f.id).sort()).toEqual([
      "reliability/no-circuit-breaker",
      "reliability/retry-storm",
    ]);
    const e = d.edges.find((x) => x.id === "service:items-api->external:billing:calls");
    expect(e?.evidence.some((x) => x.source === "experiment")).toBe(true);
    expect(e?.confidence).toBe(0.95); // noisy-OR(experiment 0.9, static 0.5)
    expect(d.coverage.sources.experiments).toBe(true);
  });

  it("Prometheus metrics give route p95/error rate/rps (two scrapes)", async () => {
    const scrape = (n200: number, n500: number) => `# TYPE http_requests_total counter
http_requests_total{method="GET",route="/items/:id",status="200"} ${n200}
http_requests_total{method="GET",route="/items/:id",status="500"} ${n500}
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{method="GET",route="/items/:id",le="0.01"} 50
http_request_duration_seconds_bucket{method="GET",route="/items/:id",le="0.1"} 100
http_request_duration_seconds_bucket{method="GET",route="/items/:id",le="+Inf"} 100
http_request_duration_seconds_count{method="GET",route="/items/:id"} 100
`;
    const r = await build({
      prometheus: [
        { text: scrape(90, 10), atMs: 0 },
        { text: scrape(190, 10), atMs: 10_000 },
      ],
    });
    const get = r.data?.nodes.find((n) => n.id === "route:items-api:GET /items/{itemId}");
    expect(get?.observed?.source).toBe("metrics");
    expect(get?.observed?.p95Ms).toBeCloseTo(91, 6); // 10 + (95-50)/50 * 90 ms
    expect(get?.observed?.rps).toBe(10);
    expect(r.data?.coverage.sources.metrics).toBe(true);
  });

  it("invalid input → ConfigError; engine facade", async () => {
    expect(() => parseModelInput({ nope: 1 })).toThrow(/SW_CONFIG_MODEL|Invalid model input/);
    expect(modelEngine.id).toBe("model");
    const r = await buildModel({}, {});
    expect(r.data?.nodes).toEqual([]);
    expect(r.data?.coverage.banner).toContain("Source-only model");
  });

  it("cancelled when the signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await buildModel({ architectureData: arch }, { signal: ac.signal });
    expect(r.status).toBe("cancelled");
  });
});

describe("exports", () => {
  it("DOT escapes quotes, backslashes and newlines", () => {
    expect(dotEscape('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    const dot = modelToDot({
      nodes: [{ id: 'route:x:GET /a"b', kind: "route", names: ['GET /a"b'], evidence: [], confidence: 0.75 }],
      edges: [],
    });
    expect(dot).toContain('"route:x:GET /a\\"b"');
    expect(dot.startsWith('digraph "system-model" {')).toBe(true);
  });

  it("Mermaid uses safe ids and entity-escaped labels", () => {
    expect(mermaidEscape('a"<b>|[c]{d}(e)&')).toBe("a#quot;#lt;b#gt;#124;#91;c#93;#123;d#125;#40;e#41;#amp;");
    const m = modelToMermaid({
      nodes: [
        { id: "service:a", kind: "service", names: ['A "svc"'], evidence: [], confidence: 0.9 },
        {
          id: "datastore:b",
          kind: "datastore",
          names: ["b|db"],
          evidence: [],
          confidence: 0.2,
        },
      ],
      edges: [
        {
          id: "service:a->datastore:b:reads",
          from: "service:a",
          to: "datastore:b",
          kind: "reads",
          evidence: [],
          confidence: 0.2,
        },
      ],
    });
    expect(m).toContain('n1[["A #quot;svc#quot;<br/>service · 90%"]]');
    expect(m).toContain('n0[("b#124;db<br/>datastore · 20%")]');
    expect(m).toContain('n1 -.->|"reads"| n0');
    expect(m).not.toContain("hypothesis");
    expect(m).not.toMatch(/\[\[A "svc"/);
  });

  it("canonical JSON is deterministic regardless of input order", async () => {
    const r = await build();
    const d = r.data as ModelData;
    const shuffled: ModelData = {
      ...d,
      nodes: [...d.nodes].reverse(),
      edges: [...d.edges].reverse(),
      merges: [...d.merges].reverse(),
    };
    expect(toCanonicalJson(shuffled)).toBe(toCanonicalJson(d));
    expect(JSON.parse(toCanonicalJson(d)).nodes.length).toBe(d.nodes.length);
  });

  it("snapshots round-trip and the graph is reattached", async () => {
    const r = await build();
    await withTmpDir(async (dir) => {
      const saved = await saveModelSnapshot(r.data as ModelData, { dir: dir.path });
      const loaded = await loadModelSnapshot(saved.latest);
      expect(loaded.nodes.length).toBe(r.data?.nodes.length);
      expect(loaded.graph.routesReaching("billing")).toEqual(["route:items-api:POST /items"]);
      expect(diffModels(r.data as ModelData, loaded).summary.unchanged).toBe(true);
    });
  });
});

describe("queries", () => {
  it("impactOf, routesReaching, neighbourhood, find", async () => {
    const r = await build({ config: { files: [], discover: false } });
    const g = r.data?.graph;
    expect(g?.find("Billing").map((n) => n.id)).toEqual(["external:billing"]);
    expect(g?.routesReaching("datastore:postgres")).toEqual([
      "route:items-api:GET /items/{itemId}",
      "route:items-api:POST /items",
    ]);
    expect(g?.impactOf("external:billing")[0]?.depth).toBe(1);
    const nb = g?.neighbourhood("external:billing", 1);
    expect(nb?.nodes.map((n) => n.id).sort()).toEqual([
      "external:billing",
      "route:items-api:POST /items",
      "service:items-api",
    ]);
    const nb2 = g?.neighbourhood("external:billing", 2);
    expect(nb2?.nodes.map((n) => n.id)).toContain("datastore:postgres");
    expect(nb2?.depth["datastore:postgres"]).toBe(2);
    expect(g?.dependenciesOf("service:items-api").sort()).toEqual(["datastore:postgres", "external:billing"]);
    expect(g?.neighbourhood("nope")).toBeUndefined();
  });
});

describe("diffModels", () => {
  it("reports added/removed nodes and edges, confidence and metric changes", async () => {
    const a = (await build()).data as ModelData;
    const b = (await build({ performance: [perf] })).data as ModelData;
    const d1 = diffModels(a, b, { confidenceDelta: 0.01 });
    expect(d1.addedNodes).toEqual([]);
    expect(d1.changedConfidence.map((c) => c.id)).toContain("route:items-api:GET /items/{itemId}");
    expect(d1.changedMetrics).toEqual(
      expect.arrayContaining([{ id: "route:items-api:GET /items/{itemId}", metric: "p95Ms", after: 12.5 }]),
    );
    expect(d1.changedSources.find((c) => c.id === "route:items-api:GET /items/{itemId}")?.added).toEqual([
      "performance",
    ]);

    const perf2 = structuredClone(perf);
    (perf2.data.endpoints[0] as { latency: { corrected: { p95: number } } }).latency.corrected.p95 = 25;
    const c = (await build({ performance: [perf2] })).data as ModelData;
    const d2 = diffModels(b, c);
    expect(d2.changedMetrics).toEqual([
      { id: "route:items-api:GET /items/{itemId}", metric: "p95Ms", before: 12.5, after: 25, relChange: 1 },
    ]);

    const smaller: ModelData = {
      ...a,
      nodes: a.nodes.filter((n) => n.id !== "external:billing"),
      edges: a.edges.filter((e) => e.to !== "external:billing"),
    };
    const d3 = diffModels(smaller, a);
    expect(d3.addedNodes.map((n) => n.id)).toEqual(["external:billing"]);
    expect(d3.addedEdges.map((e) => e.id)).toEqual([
      "route:items-api:POST /items->external:billing:calls",
      "service:items-api->external:billing:calls",
    ]);
    expect(diffModels(a, smaller).removedNodes.map((n) => n.id)).toEqual(["external:billing"]);
    expect(() => diffModels(a, { ...a, schemaVersion: 2 as 1 })).toThrow(/schema/);
  });
});

describe("OTLP metrics source", () => {
  it("http.server.request.duration histograms give route p95, error rate and rps", async () => {
    const dp = (status: number, counts: string[]) => ({
      attributes: [
        { key: "http.route", value: { stringValue: "/items/:id" } },
        { key: "http.request.method", value: { stringValue: "GET" } },
        { key: "http.response.status_code", value: { intValue: String(status) } },
      ],
      startTimeUnixNano: "1761700000000000000",
      timeUnixNano: "1761700010000000000",
      count: String(counts.reduce((a, b) => a + Number(b), 0)),
      bucketCounts: counts,
      explicitBounds: [0.01, 0.1],
    });
    const payload = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "items-api" } }] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "http.server.request.duration",
                  unit: "s",
                  histogram: {
                    aggregationTemporality: 2,
                    dataPoints: [dp(200, ["40", "50", "0"]), dp(500, ["0", "10", "0"])],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const r = await build({ telemetry: { payloads: [payload] } });
    const get = r.data?.nodes.find((n) => n.id === "route:items-api:GET /items/{itemId}");
    expect(get?.observed).toMatchObject({ source: "metrics", requests: 100, errorRate: 0.1, rps: 10 });
    // p95: rank 95 of 100 → bucket (0.01, 0.1] holding 60 obs after 40 → 0.01 + 0.09 * 55/60 s
    expect(get?.observed?.p95Ms).toBeCloseTo((0.01 + (0.09 * 55) / 60) * 1000, 3);
    expect(get?.evidence.some((e) => e.source === "metrics")).toBe(true);
    // The OTel service.name "items-api" resolves to the primary service by name.
    expect(r.data?.nodes.filter((n) => n.kind === "service").map((n) => n.id)).toEqual(["service:items-api"]);
  });
});
