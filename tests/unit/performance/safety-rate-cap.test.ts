/**
 * docs/11 §1: safety.maxRps is enforced in every model. Closed/iterations VUs wait on the lease's
 * GCRA (not counted as latency) and the run records PERF-THROTTLED-BY-SAFETY.
 */
import { describe, expect, it } from "vitest";
import type {
  HttpExecutor,
  HttpRequestSpec,
  HttpResult,
} from "../../../src/adapters/http/undici-executor.js";
import { SafetyError } from "../../../src/core/errors.js";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import { runPerformance } from "../../../src/engines/performance/index.js";

function fastExecutor(): HttpExecutor & { seen: HttpRequestSpec[] } {
  const seen: HttpRequestSpec[] = [];
  return {
    seen,
    inFlight: 0,
    openSockets: 0,
    async execute(req): Promise<HttpResult> {
      seen.push(req);
      const t = performance.now();
      await new Promise<void>((r) => setImmediate(r));
      const e = performance.now();
      return { status: 200, bytesIn: 0, bytesOut: 0, tStart: t, tHeaders: e, tEnd: e };
    },
    async close() {},
  };
}

const target = "http://127.0.0.1:9";
const scenarios = [{ name: "s", steps: [{ path: "/" }] }];

describe("safety.maxRps in VU models", () => {
  it("closed model: only safety.maxRps set → GCRA caps throughput and records the limitation", async () => {
    const safety = createSafetyGuard({ maxRps: 50 }, { interactive: false });
    const ex = fastExecutor();
    const res = await runPerformance(
      { target, vus: 10, duration: "1s", scenarios },
      { safety },
      { executor: ex },
    );
    // unthrottled this would be thousands; GCRA allows 50/s plus a burst of ceil(50/10) = 5
    expect(ex.seen.length).toBeLessThanOrEqual(50 + 5 + 2);
    expect(ex.seen.length).toBeGreaterThanOrEqual(40);
    expect(res.limitations.map((l) => l.code)).toContain("PERF-THROTTLED-BY-SAFETY");
    expect(res.data?.totals.throttled).toBeGreaterThan(0);
    // waiting for a token is not latency: counted, 10 VUs at 50/s would wait ~200 ms per request.
    // p50, not p99: with ~55 samples p99 is the max, and one event-loop stall under a loaded parallel
    // suite (a setImmediate "request" taking 25 ms) failed it on Linux.
    expect(res.data?.latency.raw.p50).toBeLessThan(20);
  });

  it("iterations model: work completes at the cap", async () => {
    const safety = createSafetyGuard({ maxRps: 40 }, { interactive: false });
    const ex = fastExecutor();
    const t = performance.now();
    const res = await runPerformance(
      { target, iterations: 44, vus: 4, scenarios },
      { safety },
      { executor: ex },
    );
    const elapsed = performance.now() - t;
    expect(res.data?.totals.requests).toBe(44);
    // 44 requests at 40/s with a burst of 4 need about 1 s
    expect(elapsed).toBeGreaterThan(850);
    expect(res.limitations.map((l) => l.code)).toContain("PERF-THROTTLED-BY-SAFETY");
  });

  it("budget.maxRps below safety.maxRps wins (min of both)", async () => {
    const safety = createSafetyGuard({ maxRps: 1000 }, { interactive: false });
    const ex = fastExecutor();
    const res = await runPerformance(
      { target, vus: 5, duration: "1s", budget: { maxRps: 30 }, scenarios },
      { safety },
      { executor: ex },
    );
    expect(ex.seen.length).toBeLessThanOrEqual(30 + 3 + 2);
    expect(res.limitations.find((l) => l.code === "PERF-THROTTLED-BY-SAFETY")?.message).toMatch(/30 req\/s/);
  });

  it("a cap far above the load → no throttling and no limitation", async () => {
    const safety = createSafetyGuard({ maxRps: 1_000_000 }, { interactive: false });
    const ex = fastExecutor();
    const res = await runPerformance(
      { target, iterations: 200, vus: 4, scenarios },
      { safety },
      { executor: ex },
    );
    expect(res.data?.totals.requests).toBe(200);
    expect(res.limitations.map((l) => l.code)).not.toContain("PERF-THROTTLED-BY-SAFETY");
  });

  it("open model above safety.maxRps is still refused up front", async () => {
    const safety = createSafetyGuard({ maxRps: 100 }, { interactive: false });
    await expect(
      runPerformance(
        { target, rate: 200, duration: "1s", scenarios },
        { safety },
        { executor: fastExecutor() },
      ),
    ).rejects.toBeInstanceOf(SafetyError);
  });
});
