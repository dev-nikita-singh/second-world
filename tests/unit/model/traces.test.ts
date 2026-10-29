import { describe, expect, it } from "vitest";
import type { NormalizedSpan, SpanKind } from "../../../src/adapters/telemetry/otlp.js";
import { fromTraces } from "../../../src/engines/model/sources/traces.js";
import { buildTraceTrees, criticalPath, peerOf, serverRouteOf } from "../../../src/engines/model/traces.js";

function sp(
  id: string,
  parent: string | undefined,
  startMs: number,
  endMs: number,
  extra: Partial<NormalizedSpan> & { kind?: SpanKind } = {},
): NormalizedSpan {
  return {
    traceId: extra.traceId ?? "t1",
    spanId: id,
    ...(parent ? { parentSpanId: parent } : {}),
    name: extra.name ?? id,
    kind: extra.kind ?? "internal",
    startUs: startMs * 1000,
    endUs: endMs * 1000,
    durationUs: (endMs - startMs) * 1000,
    status: extra.status ?? "unset",
    service: extra.service ?? "svc",
    attributes: extra.attributes ?? {},
    resource: {},
  };
}

const total = (segs: { startUs: number; endUs: number }[]) =>
  segs.reduce((s, x) => s + (x.endUs - x.startUs), 0) / 1000;
const bySpan = (segs: ReturnType<typeof criticalPath>) => {
  const m: Record<string, number> = {};
  for (const s of segs) m[s.node.span.spanId] = (m[s.node.span.spanId] ?? 0) + (s.endUs - s.startUs) / 1000;
  return m;
};

describe("span tree", () => {
  it("builds trees from out-of-order spans, counts orphans and breaks cycles", () => {
    const spans = [
      sp("c2", "root", 30, 40),
      sp("c1", "root", 10, 20),
      sp("root", undefined, 0, 50),
      sp("gc", "c1", 12, 18),
      sp("orphan", "missing", 5, 6),
      // cycle x ↔ y (malformed export)
      sp("x", "y", 1, 2, { traceId: "t2" }),
      sp("y", "x", 0, 3, { traceId: "t2" }),
    ];
    const trees = buildTraceTrees(spans);
    const t1 = trees.find((t) => t.traceId === "t1");
    expect(t1?.roots.map((r) => r.span.spanId)).toEqual(["root", "orphan"]);
    expect(t1?.orphans).toBe(1);
    const root = t1?.roots[0];
    expect(root?.children.map((c) => c.span.spanId)).toEqual(["c1", "c2"]); // sorted by start
    expect(root?.children[0]?.children[0]?.span.spanId).toBe("gc");
    const t2 = trees.find((t) => t.traceId === "t2");
    expect(t2?.roots.map((r) => r.span.spanId)).toEqual(["y"]);
    expect(t2?.brokenLinks).toBe(1);
    expect(t2?.roots[0]?.children.map((c) => c.span.spanId)).toEqual(["x"]);
  });
});

describe("critical path", () => {
  it("sums sequential children and takes the max of parallel children (known answer)", () => {
    // root 0..85: A 0..50 ∥ B 0..30, then C 50..80, then self 80..85
    const trees = buildTraceTrees([
      sp("root", undefined, 0, 85),
      sp("A", "root", 0, 50),
      sp("B", "root", 0, 30),
      sp("C", "root", 50, 80),
    ]);
    const segs = criticalPath(trees[0]?.roots[0] as NonNullable<(typeof trees)[0]["roots"][0]>);
    expect(segs.map((s) => s.node.span.spanId)).toEqual(["A", "C", "root"]);
    expect(bySpan(segs)).toEqual({ A: 50, C: 30, root: 5 });
    expect(total(segs)).toBe(85);
  });

  it("counts self-time gaps and nested grandchildren", () => {
    // root 0..100: self 0..10, P 10..60 (self 10..20, Q 20..60), self 60..70, R 70..90, self 90..100
    const trees = buildTraceTrees([
      sp("root", undefined, 0, 100),
      sp("P", "root", 10, 60),
      sp("Q", "P", 20, 60),
      sp("R", "root", 70, 90),
    ]);
    const segs = criticalPath(trees[0]?.roots[0] as NonNullable<(typeof trees)[0]["roots"][0]>);
    expect(bySpan(segs)).toEqual({ root: 30, P: 10, Q: 40, R: 20 });
    expect(segs.map((s) => [s.node.span.spanId, s.startUs / 1000, s.endUs / 1000])).toEqual([
      ["root", 0, 10],
      ["P", 10, 20],
      ["Q", 20, 60],
      ["root", 60, 70],
      ["R", 70, 90],
      ["root", 90, 100],
    ]);
  });

  it("clamps partially overlapping and out-of-bounds children", () => {
    // A 0..50 and B 20..60 overlap: B is last to finish (20..60), A contributes 0..20.
    // C starts before its parent and ends after it (clock skew) → clamped to the parent.
    const trees = buildTraceTrees([
      sp("root", undefined, 0, 60),
      sp("A", "root", 0, 50),
      sp("B", "root", 20, 60),
      sp("x", undefined, 100, 110, { traceId: "t9" }),
      sp("C", "x", 95, 120, { traceId: "t9" }),
    ]);
    const t1 = trees.find((t) => t.traceId === "t1");
    const segs = criticalPath(t1?.roots[0] as NonNullable<NonNullable<typeof t1>["roots"][0]>);
    expect(bySpan(segs)).toEqual({ A: 20, B: 40 });
    const t9 = trees.find((t) => t.traceId === "t9");
    const s9 = criticalPath(t9?.roots[0] as NonNullable<NonNullable<typeof t9>["roots"][0]>);
    expect(bySpan(s9)).toEqual({ C: 10 });
  });

  it("is iterative (deep chains do not overflow the stack)", () => {
    const spans = [sp("s0", undefined, 0, 20_000)];
    for (let i = 1; i < 20_000; i++) spans.push(sp(`s${i}`, `s${i - 1}`, i, 20_000));
    const t = buildTraceTrees(spans)[0];
    const segs = criticalPath(t?.roots[0] as NonNullable<NonNullable<typeof t>["roots"][0]>);
    expect(total(segs)).toBe(20_000);
  });
});

describe("peers and routes", () => {
  it("derives peers from new and legacy semantic conventions", () => {
    expect(
      peerOf(
        sp("a", undefined, 0, 1, {
          kind: "client",
          attributes: { "peer.service": "payments", "server.address": "127.0.0.1", "server.port": 4010 },
        }),
      ),
    ).toMatchObject({
      name: "payments",
      kind: "external",
      hosts: ["127.0.0.1:4010"],
      serviceNames: ["payments"],
    });
    expect(
      peerOf(
        sp("b", undefined, 0, 1, {
          kind: "client",
          attributes: { "http.url": "https://api.stripe.com/v1/charges" },
        }),
      ),
    ).toMatchObject({
      name: "api.stripe.com",
      hosts: ["api.stripe.com:443"],
    });
    expect(
      peerOf(
        sp("c", undefined, 0, 1, {
          kind: "client",
          attributes: {
            "db.system": "postgresql",
            "db.name": "shop",
            "db.statement": "update x set y=1",
            "net.peer.name": "db",
            "net.peer.port": 5432,
          },
        }),
      ),
    ).toMatchObject({
      name: "shop",
      kind: "datastore",
      op: "writes",
      hosts: ["db:5432"],
    });
    expect(
      peerOf(
        sp("d", undefined, 0, 1, {
          kind: "client",
          attributes: { "db.system": "redis", "db.operation": "GET" },
        }),
      ),
    ).toMatchObject({ kind: "cache", op: "reads" });
    expect(
      peerOf(
        sp("e", undefined, 0, 1, {
          kind: "producer",
          attributes: { "messaging.system": "kafka", "messaging.destination.name": "orders" },
        }),
      ),
    ).toMatchObject({
      name: "orders",
      kind: "queue",
      op: "publishes",
    });
    expect(peerOf(sp("f", undefined, 0, 1, { kind: "server" }))).toBeUndefined();
    expect(
      serverRouteOf(
        sp("g", undefined, 0, 1, {
          kind: "server",
          attributes: { "http.method": "get", "http.route": "/p/:id" },
        }),
      ),
    ).toEqual({ method: "GET", path: "/p/:id" });
    expect(serverRouteOf(sp("h", undefined, 0, 1, { kind: "server", name: "POST /orders" }))).toEqual({
      method: "POST",
      path: "/orders",
    });
  });

  it("aggregates service→peer and route→peer edges with callsPerRequest, p95, links and critical path", () => {
    const spans: NormalizedSpan[] = [];
    for (let i = 0; i < 4; i++) {
      const t = `t${i}`;
      const o = i * 1000;
      spans.push(
        sp(`r${i}`, undefined, o, o + 100, {
          traceId: t,
          kind: "server",
          service: "shop",
          attributes: {
            "http.request.method": "POST",
            "http.route": "/orders",
            "server.address": "localhost",
            "server.port": 3000,
          },
        }),
        sp(`db${i}a`, `r${i}`, o + 1, o + 5, {
          traceId: t,
          kind: "client",
          service: "shop",
          attributes: { "db.system": "sqlite", "db.name": "main", "db.operation": "SELECT" },
        }),
        sp(`db${i}b`, `r${i}`, o + 5, o + 9, {
          traceId: t,
          kind: "client",
          service: "shop",
          attributes: { "db.system": "sqlite", "db.name": "main", "db.operation": "SELECT" },
        }),
        sp(`c${i}`, `r${i}`, o + 10, o + 90, {
          traceId: t,
          kind: "client",
          service: "shop",
          attributes: { "peer.service": "payments" },
        }),
        sp(`p${i}`, `c${i}`, o + 12, o + 88, {
          traceId: t,
          kind: "server",
          service: "payments-svc",
          attributes: { "http.route": "/charges", "http.request.method": "POST" },
        }),
      );
    }
    const set = fromTraces(spans);
    const edge = (from: string, to: string) => set.edges.find((e) => e.from === from && e.to === to);
    expect(edge("trace:svc:shop", "trace:peer:datastore:main")?.observed).toMatchObject({
      calls: 8,
      callsPerRequest: 2,
      p95Ms: 4,
    });
    expect(edge("trace:route:shop:POST /orders", "trace:peer:external:payments")?.observed).toMatchObject({
      calls: 4,
      callsPerRequest: 1,
      p95Ms: 80,
    });
    expect(set.links).toEqual([
      expect.objectContaining({
        a: "trace:peer:external:payments",
        b: "trace:svc:payments-svc",
        rule: "trace-link",
      }),
    ]);
    const shop = set.nodes.find((x) => x.key === "trace:svc:shop");
    expect(shop?.hosts).toEqual(["127.0.0.1:3000"]);
    expect(shop?.observed).toMatchObject({ requests: 4, p95Ms: 100, errorRate: 0 });
    const cp = set.pendingCritical.find((p) => p.traceId === "t0");
    const ms = (key: string) => cp?.segments.filter((s) => s.key === key).reduce((a, s) => a + s.ms, 0);
    expect(ms("trace:peer:external:payments")).toBe(80); // client + remote server time
    expect(ms("trace:peer:datastore:main")).toBe(8);
    expect(ms("trace:svc:shop")).toBe(12);
  });
});
