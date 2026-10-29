/**
 * Regressions reported by sw-qa (wave 5):
 * - `--model iterations` with a config `warmup` ran every iteration inside the warm-up window, so
 *   nothing was measured.
 * - A run with zero measured requests reported its thresholds as `threshold-breach` findings
 *   computed from "no data"; it is an invalid run instead (status error, no breach findings).
 */
import { describe, expect, it } from "vitest";
import type { HttpExecutor, HttpRequestSpec, HttpResult } from "../../../src/adapters/http/undici-executor.js";
import { parsePerformanceInput, runPerformance } from "../../../src/engines/performance/index.js";

function fastExecutor(delayMs = 0): HttpExecutor & { seen: HttpRequestSpec[] } {
  const seen: HttpRequestSpec[] = [];
  return {
    seen,
    inFlight: 0,
    openSockets: 0,
    async execute(req): Promise<HttpResult> {
      seen.push(req);
      const t = performance.now();
      if (delayMs > 0) await new Promise<void>((r) => setTimeout(r, delayMs));
      else await new Promise<void>((r) => setImmediate(r));
      const e = performance.now();
      return { status: 200, bytesIn: 0, bytesOut: 0, tStart: t, tHeaders: e, tEnd: e };
    },
    async close() {},
  };
}

const target = "http://127.0.0.1:9";
const scenarios = [{ name: "s", steps: [{ path: "/" }] }];

describe("iterations model and warm-up", () => {
  it("the schema drops warm-up for iterations and remembers it", () => {
    const p = parsePerformanceInput({ target, iterations: 10, warmup: "2s", scenarios });
    expect(p.warmup).toBe(0);
    expect(p.warmupIgnoredMs).toBe(2000);
    expect(parsePerformanceInput({ target, vus: 2, duration: "1s", warmup: "2s", scenarios }).warmup).toBe(2000);
  });

  it("every requested iteration is measured; the ignored warm-up is reported", async () => {
    const res = await runPerformance(
      { target, iterations: 100, vus: 5, warmup: "2s", scenarios, thresholds: { "http.p95": "< 200ms" } },
      {},
      { executor: fastExecutor() },
    );
    expect(res.data?.totals.requests).toBe(100);
    expect(res.status).toBe("passed");
    expect(res.findings).toHaveLength(0);
    expect(res.limitations.map((l) => l.code)).toContain("warmup-ignored-iterations");
  });

  it("zero measured requests → status error, no threshold-breach findings", async () => {
    // The only request starts in the warm-up and returns after the measured window ended.
    const res = await runPerformance(
      { target, vus: 1, warmup: "300ms", duration: "100ms", timeout: "5s", scenarios, thresholds: { "http.p95": "< 200ms" } },
      {},
      { executor: fastExecutor(600) },
    );
    expect(res.limitations.map((l) => l.code)).toContain("no-measurements");
    expect(res.status).toBe("error");
    expect(res.findings.filter((f) => f.classification === "threshold-breach")).toHaveLength(0);
  });
});
