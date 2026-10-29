import { describe, expect, it } from "vitest";
import type {
  HttpExecutor,
  HttpRequestSpec,
  HttpResult,
} from "../../../src/adapters/http/undici-executor.js";
import { EngineResultSchema } from "../../../src/core/evidence/schemas.js";
import { runPerformance } from "../../../src/engines/performance/index.js";
import { evaluateGeneratorHealth } from "../../../src/engines/performance/self-check.js";

/** In-memory transport: responds after `delayMs` with whatever `respond` returns. */
function fakeExecutor(
  respond: (req: HttpRequestSpec) => Partial<HttpResult>,
  delayMs = 1,
): HttpExecutor & { seen: HttpRequestSpec[] } {
  let inFlight = 0;
  const seen: HttpRequestSpec[] = [];
  return {
    seen,
    get inFlight() {
      return inFlight;
    },
    openSockets: 0,
    async execute(req, signal) {
      seen.push(req);
      inFlight++;
      const tStart = performance.now();
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
      } catch {
        const now = performance.now();
        return {
          status: 0,
          bytesIn: 0,
          bytesOut: 0,
          tStart,
          tHeaders: now,
          tEnd: now,
          error: { kind: "aborted", message: "aborted" },
        };
      } finally {
        inFlight--;
      }
      const tEnd = performance.now();
      return { status: 200, bytesIn: 2, bytesOut: 0, tStart, tHeaders: tEnd, tEnd, ...respond(req) };
    },
    async close() {},
  };
}

const target = "http://127.0.0.1:9";

describe("performance engine (fake transport)", () => {
  it("iterations model runs exactly N iterations and returns a schema-valid result", async () => {
    const ex = fakeExecutor(() => ({}));
    const res = await runPerformance(
      { target, iterations: 40, vus: 4, scenarios: [{ name: "a", steps: [{ path: "/a" }] }] },
      {},
      { executor: ex },
    );
    expect(EngineResultSchema.parse(res).status).toBe("passed");
    expect(res.data?.totals.requests).toBe(40);
    expect(res.data?.totals.iterations).toBe(40);
    expect(res.data?.scenarios[0]?.iterations).toBe(40);
    expect(ex.seen).toHaveLength(40);
  });

  it("chains extracted variables into later steps", async () => {
    let n = 0;
    const ex = fakeExecutor((req) =>
      req.method === "POST" ? { status: 201, body: Buffer.from(JSON.stringify({ id: `c${++n}` })) } : {},
    );
    const res = await runPerformance(
      {
        target,
        iterations: 3,
        vus: 1,
        scenarios: [
          {
            name: "chain",
            steps: [
              {
                method: "POST",
                path: "/cart",
                json: { qty: 1 },
                extract: { id: "$.id" },
                expect: { status: 201 },
              },
              { path: "/cart/{{id}}" },
            ],
          },
        ],
      },
      {},
      { executor: ex },
    );
    expect(res.data?.totals.failed).toBe(0);
    expect(ex.seen.filter((r) => r.method === "GET").map((r) => r.path)).toEqual([
      "/cart/c1",
      "/cart/c2",
      "/cart/c3",
    ]);
    expect(res.data?.endpoints.map((e) => e.key).sort()).toEqual(["GET /cart/{{id}}", "POST /cart"]);
  });

  it("stops when the request budget is exhausted", async () => {
    const ex = fakeExecutor(() => ({}));
    const res = await runPerformance(
      {
        target,
        iterations: 50,
        vus: 2,
        budget: { maxRequests: 10 },
        scenarios: [{ name: "a", steps: [{ path: "/" }] }],
      },
      {},
      { executor: ex },
    );
    expect(ex.seen).toHaveLength(10);
    expect(res.data?.window.stopReason).toBe("budget-exhausted");
    expect(res.limitations.map((l) => l.code)).toContain("budget-exhausted");
  });

  it("abortOnFail stops the run early with a threshold-breach finding", async () => {
    const ex = fakeExecutor(() => ({ status: 500 }));
    const t = performance.now();
    const res = await runPerformance(
      {
        target,
        rate: 50,
        duration: "10s",
        gracefulStop: "200ms",
        scenarios: [{ name: "a", steps: [{ path: "/" }] }],
        thresholds: { "http.error_rate": { expr: "< 1%", abortOnFail: true } },
      },
      {},
      { executor: ex, tickMs: 100 },
    );
    expect(performance.now() - t).toBeLessThan(3000);
    expect(res.status).toBe("failed");
    expect(res.data?.window.stopReason).toBe("threshold-abort");
    expect(res.data?.thresholds[0]?.aborted).toBe(true);
    expect(res.findings[0]?.classification).toBe("threshold-breach");
  });

  it("graceful stop aborts stuck in-flight requests and counts them as interrupted", async () => {
    const ex = fakeExecutor(() => ({}), 60_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const res = await runPerformance(
      {
        target,
        vus: 3,
        duration: "30s",
        gracefulStop: "100ms",
        scenarios: [{ name: "a", steps: [{ path: "/" }] }],
      },
      { signal: ac.signal },
      { executor: ex },
    );
    expect(res.status).toBe("cancelled");
    expect(res.data?.totals.interrupted).toBe(3);
    expect(res.data?.totals.requests).toBe(0);
  });
});

describe("generator self-check rules", () => {
  const base = {
    model: "open" as const,
    eldP99Ms: 5,
    eldMaxMs: 10,
    cpuMs: 100,
    spinMs: 0,
    wallMs: 1000,
    lagP99Ms: 0.5,
    lagMaxMs: 1,
    intervalMs: 10,
    targetRate: 100,
    achievedRate: 100,
    dropped: 0,
    meanInFlight: 5,
    completed: 300,
    measuredMs: 3000,
    throughput: 100,
    meanLatencyMs: 50,
    latencyFlat: true,
    maxOpenSockets: 5,
    connections: 64,
  };

  it("healthy generator → no limitation", () => {
    const r = evaluateGeneratorHealth(base);
    expect(r.health.saturated).toBe(false);
    expect(r.limitations).toHaveLength(0);
    expect(r.health.littlesLawExpected).toBe(5);
  });

  it("flags each §6 condition", () => {
    const cases: Partial<typeof base>[] = [
      { eldP99Ms: 80 },
      { cpuMs: 900 },
      { lagP99Ms: 5 },
      { achievedRate: 90 },
      { meanInFlight: 2 },
      { dropped: 3 },
    ];
    for (const c of cases) {
      const r = evaluateGeneratorHealth({ ...base, ...c });
      expect(r.health.saturated, JSON.stringify(c)).toBe(true);
      expect(r.limitations[0]?.code).toBe("generator-saturated");
      expect(r.health.remedies.length).toBeGreaterThan(0);
    }
  });

  it("busy-wait time is not counted as generator CPU", () => {
    const r = evaluateGeneratorHealth({ ...base, cpuMs: 950, spinMs: 900 });
    expect(r.health.cpuPercent).toBeCloseTo(5, 3);
    expect(r.health.saturated).toBe(false);
  });
});
