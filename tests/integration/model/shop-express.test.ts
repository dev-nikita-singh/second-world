/**
 * System Model on examples/shop-express (ground truth): static analysis (temp cacheDir — never write into
 * examples/), OpenAPI, deployment config fixture, OTLP trace fixtures; OTLP receiver; diff between builds.
 */
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ArchitectureData, inspectArchitecture } from "../../../src/engines/architecture/index.js";
import {
  buildModel,
  diffModels,
  type ModelData,
  type ModelDataWithGraph,
  parseOtlp,
  startOtlpReceiver,
} from "../../../src/engines/model/index.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

const ROOT = path.resolve(__dirname, "../../..");
const PROJECT = path.join(ROOT, "examples/shop-express");
const FIX = path.join(ROOT, "tests/fixtures/model");
const CONFIG = [path.join(FIX, "shop-config/docker-compose.yml"), path.join(FIX, "shop-config/.env.example")];
const TRACES = [path.join(FIX, "shop-traces.json"), path.join(FIX, "payments-traces.jsonl")];

let tmp: TmpDir;
let arch: ArchitectureData;
let full: ModelDataWithGraph;
const hadDotDir = existsSync(path.join(PROJECT, ".second-world"));

beforeAll(async () => {
  tmp = await makeTmpDir("sw-model-int-");
  const a = await inspectArchitecture({ project: PROJECT, cacheDir: tmp.join("arch") });
  arch = a.data as ArchitectureData;
  const r = await buildModel({
    project: PROJECT,
    architectureData: arch,
    openapi: "openapi.yaml",
    config: { files: CONFIG, discover: true },
    traces: TRACES,
  });
  expect(r.status).toBe("passed");
  full = r.data as ModelDataWithGraph;
}, 120_000);

afterAll(async () => {
  await tmp?.cleanup();
});

const node = (id: string) => full.nodes.find((n) => n.id === id);
const edge = (id: string) => full.edges.find((e) => e.id === id);
const sources = (x: { evidence: { source: string }[] } | undefined) =>
  [...new Set(x?.evidence.map((e) => e.source))].sort();

describe("shop-express model", () => {
  it("resolves the payments provider to ONE node from code, env, compose and traces", () => {
    const payNodes = full.nodes.filter((n) => n.kind !== "route" && n.names.some((x) => /payment/i.test(x)));
    expect(payNodes.map((n) => n.id)).toEqual(["service:payments-fake"]);
    const pay = payNodes[0] as (typeof payNodes)[number];
    expect(pay.names).toEqual(expect.arrayContaining(["payments-fake", "payments", "PAYMENTS_URL"]));
    expect(pay.hosts).toEqual(["127.0.0.1:4010", "payments:4010"]);
    expect(sources(pay)).toEqual(["config", "static", "static-heuristic", "trace"]);
    // Code evidence: the fetch call site and the env read.
    expect(pay.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "static-heuristic", origin: "src/payments-client.ts" }),
        expect.objectContaining({
          source: "static",
          origin: "src/server.ts",
          detail: "code reads process.env.PAYMENTS_URL",
        }),
        expect.objectContaining({ source: "config", detail: "PAYMENTS_URL=http://payments:4010" }),
      ]),
    );
    const rules = new Set(full.merges.filter((m) => m.node === pay.id).map((m) => m.rule));
    expect(rules).toEqual(new Set(["env-url", "host-port", "trace-link"]));
    expect(pay.proposedMerge).toBeUndefined();
    expect(pay.confidence).toBeGreaterThan(0.99);
  });

  it("resolves the shop itself (static + OpenAPI servers + compose ports + trace service.name)", () => {
    expect(full.primaryService).toBe("service:shop-express");
    const shop = node("service:shop-express");
    expect(shop?.names).toEqual(expect.arrayContaining(["shop-express", "shop"]));
    expect(shop?.hosts).toEqual(["127.0.0.1:3000", "shop:3000"]);
    expect(sources(shop)).toEqual(["config", "openapi", "static", "trace"]);
    expect(
      full.nodes
        .filter((n) => n.kind === "service")
        .map((n) => n.id)
        .sort(),
    ).toEqual(["service:payments-fake", "service:shop-express"]);
  });

  it("merges the in-memory Db (static heuristic) with traced db spans as a proposed merge", () => {
    const dbs = full.nodes.filter((n) => n.kind === "datastore" && n.names.includes("Db"));
    expect(dbs).toHaveLength(1);
    expect(dbs[0]?.proposedMerge).toBe(true);
    expect(sources(dbs[0])).toEqual(["static-heuristic", "trace"]);
    expect(full.merges.find((m) => m.node === dbs[0]?.id)).toMatchObject({
      rule: "name-similarity",
      proposed: true,
    });
    expect(full.limitations.map((l) => l.code)).toContain("MODEL_PROPOSED_MERGES");
  });

  it("matches every route across static analysis, OpenAPI and traces (no duplicates)", () => {
    const routes = full.nodes.filter((n) => n.kind === "route" && n.service === "service:shop-express");
    const sigs = routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(sigs).size).toBe(sigs.length);
    expect(sigs).toEqual(
      expect.arrayContaining([
        "GET /products",
        "GET /products/{id}",
        "POST /orders",
        "GET /orders/{id}",
        "POST /cart/items",
      ]),
    );
    for (const r of routes) {
      const s = sources(r);
      if (s.includes("openapi")) expect(s).toContain("static");
    }
    // Test-only hooks exist in code but not in the contract.
    expect(sources(node("route:shop-express:POST /__test/reset"))).toEqual(["static"]);
    const post = node("route:shop-express:POST /orders");
    expect(sources(post)).toEqual(["openapi", "static", "trace"]);
    expect(post?.observed).toMatchObject({ source: "trace", requests: 5, p95Ms: 100, errorRate: 0.2 });
    expect(node("route:payments-fake:POST /charges")?.service).toBe("service:payments-fake");
  });

  it("route → dependency edges carry evidence lists and observed calls", () => {
    const e = edge("route:shop-express:POST /orders->service:payments-fake:calls");
    expect(e).toBeDefined();
    expect(sources(e)).toEqual(["static-heuristic", "trace"]);
    expect(e?.observed).toMatchObject({ calls: 5, callsPerRequest: 1, errorRate: 0.2 });
    expect(e?.evidence.find((x) => x.source === "static-heuristic")).toMatchObject({
      origin: "src/payments-client.ts",
    });
    const svc = edge("service:shop-express->service:payments-fake:calls");
    expect(sources(svc)).toEqual(["config", "static", "static-heuristic", "trace"]);
    const dbId = full.nodes.find((n) => n.kind === "datastore" && n.names.includes("Db"))?.id as string;
    expect(edge(`route:shop-express:GET /products->${dbId}:reads`)?.observed).toMatchObject({
      callsPerRequest: 4,
    });
    expect(edge(`route:shop-express:GET /products/{id}->${dbId}:reads`)?.observed).toMatchObject({
      callsPerRequest: 2,
    });
    // compose depends_on shop → payments folded into the calls edge (no separate "depends" edge).
    expect(edge("service:shop-express->service:payments-fake:depends")).toBeUndefined();
  });

  it("critical path and dominant dependency per route", () => {
    const t = full.traces;
    expect(t?.traces).toBe(19);
    expect(t?.orphanSpans).toBe(1);
    expect(t?.services).toEqual(["payments-fake", "shop"]);
    const dbId = full.nodes.find((n) => n.kind === "datastore" && n.names.includes("Db"))?.id as string;
    const dom = Object.fromEntries((t?.dominant ?? []).map((d) => [d.route, d]));
    expect(dom["route:shop-express:POST /orders"]).toMatchObject({
      node: "service:payments-fake",
      share: 0.82,
      traces: 5,
    });
    // Parallel review reads contribute only the longest (12 ms) + the list read (2 ms) = 14 of 20 ms.
    expect(dom["route:shop-express:GET /products"]).toMatchObject({ node: dbId, share: 0.7, traces: 3 });
    const cp = t?.criticalPaths.find((p) => p.route === "route:shop-express:POST /orders");
    expect(cp?.durationMs).toBe(100);
    expect(cp?.segments.reduce((s, x) => s + x.ms, 0)).toBeCloseTo(100, 6);
    expect(cp?.byNode[0]).toMatchObject({ node: "service:payments-fake", ms: 82 });
  });

  it("queries: impact of the payments provider, coverage banner, exports, no secrets, examples untouched", () => {
    expect(full.graph.routesReaching("payments")).toEqual(["route:shop-express:POST /orders"]);
    expect(full.graph.impactOf("PAYMENTS_URL").map((x) => x.id)).toEqual(
      expect.arrayContaining(["route:shop-express:POST /orders", "service:shop-express"]),
    );
    expect(full.coverage.banner).toBe(
      "Built from: static analysis ✓, OpenAPI ✓, config/deployment ✓, runtime traces ✓, runtime metrics ✗, load tests ✗, experiments ✗. Runtime topology observed only within the ingested trace window.",
    );
    expect(full.graph.toDot()).toContain('"service:payments-fake"');
    expect(full.graph.toMermaid()).toContain("flowchart LR");
    const json = JSON.stringify(full);
    for (const secret of ["s3cr3t-fixture-value", "hunter2-fixture-password", "tok_live_9f8e"])
      expect(json).not.toContain(secret);
    expect(existsSync(path.join(PROJECT, ".second-world"))).toBe(hadDotDir);
  });
});

function post(
  url: string,
  body: Buffer | string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("OTLP receiver → model update → diff", () => {
  it("accepts POSTed OTLP/JSON, rejects malformed protobuf, and the rebuilt model gains runtime evidence", async () => {
    const base = {
      project: PROJECT,
      architectureData: arch,
      openapi: "openapi.yaml",
      config: { files: CONFIG, discover: false },
    };
    const before = (await buildModel(base)).data as ModelData;
    expect(before.coverage.sources.traces).toBe(false);
    expect(
      before.edges.find((e) => e.id === "route:shop-express:POST /orders->service:payments:calls")?.observed,
    ).toBeUndefined();

    const rx = await startOtlpReceiver();
    try {
      expect(rx.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const shop = readFileSync(TRACES[0] as string, "utf8");
      expect((await post(`${rx.url}/v1/traces`, shop, { "content-type": "application/json" })).status).toBe(
        200,
      );
      for (const line of readFileSync(TRACES[1] as string, "utf8")
        .split("\n")
        .filter(Boolean))
        expect(
          (
            await post(`${rx.url}/v1/traces`, gzipSync(line), {
              "content-type": "application/json",
              "content-encoding": "gzip",
            })
          ).status,
        ).toBe(200);
      const proto = await post(`${rx.url}/v1/traces`, Buffer.from([1, 2, 3]), {
        "content-type": "application/x-protobuf",
      });
      // Garbage protobuf: a clean 400 with a google.rpc.Status body (field 0 is invalid).
      expect(proto.status).toBe(400);
      expect(proto.body).toContain("invalid field number 0");
      expect((await post(`${rx.url}/v1/logs`, "{}", { "content-type": "application/json" })).status).toBe(
        404,
      );
      expect((await post(`${rx.url}/v1/traces`, "{bad", { "content-type": "application/json" })).status).toBe(
        400,
      );
      const st = rx.stats();
      expect(st.traceRequests).toBe(3);
      expect(st.rejected).toBe(3);
      const fileSpans = TRACES.map((f) => parseOtlp(readFileSync(f, "utf8")).spans.length).reduce(
        (a, b) => a + b,
        0,
      );
      expect(rx.spans()).toHaveLength(fileSpans);

      const after = (await buildModel({ ...base, telemetry: { spans: rx.spans() } })).data as ModelData;
      expect(after.coverage.sources.traces).toBe(true);
      const e = after.edges.find(
        (x) => x.id === "route:shop-express:POST /orders->service:payments-fake:calls",
      );
      expect(e?.observed?.callsPerRequest).toBe(1);

      const d = diffModels(before, after);
      // The payments node is renamed after its OTel service.name once traces arrive.
      expect(d.removedNodes.map((n) => n.id)).toContain("service:payments");
      expect(d.addedNodes.map((n) => n.id)).toEqual(
        expect.arrayContaining(["service:payments-fake", "route:payments-fake:POST /charges"]),
      );
      expect(d.changedSources.find((c) => c.id === "route:shop-express:POST /orders")?.added).toEqual([
        "trace",
      ]);
      expect(
        d.changedMetrics.some(
          (m) => m.id === "route:shop-express:POST /orders" && m.metric === "p95Ms" && m.after === 100,
        ),
      ).toBe(true);
      expect(d.changedConfidence.some((c) => c.id.startsWith("datastore:"))).toBe(true);
      expect(d.summary.unchanged).toBe(false);
      // Rebuilding with identical evidence yields an identical model (deterministic ids).
      const again = (await buildModel({ ...base, telemetry: { spans: rx.spans() } })).data as ModelData;
      expect(diffModels(after, again).summary.unchanged).toBe(true);
    } finally {
      await rx.close();
    }
  });
});

describe("OTLP receiver limits", () => {
  it("rejects oversized bodies (413), accepts metrics, calls hooks and bounds stored spans", async () => {
    const seen: number[] = [];
    const rx = await startOtlpReceiver({
      maxBodyBytes: 64 * 1024,
      maxSpans: 10,
      onSpans: (s) => seen.push(s.length),
    });
    try {
      const big = JSON.stringify({ resourceSpans: [], pad: "x".repeat(70 * 1024) });
      expect((await post(`${rx.url}/v1/traces`, big, { "content-type": "application/json" })).status).toBe(
        413,
      );
      const shop = readFileSync(TRACES[0] as string, "utf8");
      expect(
        (await post(`${rx.url}/v1/traces`, shop, { "content-type": "application/json; charset=utf-8" }))
          .status,
      ).toBe(413);
      const one = parseOtlp(shop).spans.slice(0, 1);
      const payload = {
        resourceSpans: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "shop" } }] },
            scopeSpans: [
              {
                spans: Array.from({ length: 12 }, (_, i) => ({
                  traceId: one[0]?.traceId,
                  spanId: (i + 1).toString(16).padStart(16, "0"),
                  name: "x",
                  startTimeUnixNano: "1000",
                  endTimeUnixNano: "2000",
                })),
              },
            ],
          },
        ],
      };
      expect(
        (await post(`${rx.url}/v1/traces`, JSON.stringify(payload), { "content-type": "application/json" }))
          .status,
      ).toBe(200);
      expect(rx.spans()).toHaveLength(10);
      expect(rx.stats().droppedSpans).toBe(2);
      expect(seen).toEqual([12]);
      const metrics = {
        resourceMetrics: [
          { scopeMetrics: [{ metrics: [{ name: "g", gauge: { dataPoints: [{ asDouble: 1 }] } }] }] },
        ],
      };
      expect(
        (await post(`${rx.url}/v1/metrics`, JSON.stringify(metrics), { "content-type": "application/json" }))
          .status,
      ).toBe(200);
      expect(rx.metrics()).toHaveLength(1);
      rx.clear();
      expect(rx.spans()).toHaveLength(0);
    } finally {
      await rx.close();
    }
  });
});
