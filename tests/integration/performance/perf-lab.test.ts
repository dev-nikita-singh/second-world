/**
 * Performance Lab against the calibrated fixture server (127.0.0.1, port 0).
 * Tolerances account for Windows timer granularity (~1-15 ms).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SafetyError } from "../../../src/core/errors.js";
import { createEventBus } from "../../../src/core/events.js";
import { runPerformance } from "../../../src/engines/performance/index.js";
import { LatencyHistogram } from "../../../src/shared/stats/hdr.js";
import { type CalibratedServer, startCalibratedServer } from "../../fixtures/servers/calibrated.js";

let srv: CalibratedServer;

beforeEach(async () => {
  srv = await startCalibratedServer();
});
afterEach(async () => {
  await srv.close();
});

describe("performance lab (integration)", () => {
  it("measures a fixed 50 ms endpoint: p50 within ±10 ms (closed model)", async () => {
    const res = await runPerformance({
      target: srv.url,
      vus: 5,
      duration: "2s",
      scenarios: [{ name: "fixed", steps: [{ method: "GET", path: "/fixed/50", expect: { status: 200 } }] }],
    });
    expect(res.status).toBe("passed");
    const d = res.data!;
    expect(d.totals.requests).toBeGreaterThan(50);
    expect(d.totals.failed).toBe(0);
    expect(Math.abs(d.latency.raw.p50 - 50)).toBeLessThanOrEqual(10);
    expect(Math.abs(d.latency.corrected.p50 - 50)).toBeLessThanOrEqual(10);
    expect(d.endpoints[0]?.key).toBe("GET /fixed/50");
    // encoded histograms decode and agree
    const h = LatencyHistogram.decode(d.histograms.global.raw);
    expect(h.count).toBe(d.totals.requests);
    expect(d.series.length).toBeGreaterThanOrEqual(1);
  });

  it("open model 100 rps for 3 s achieves the target rate within ±5%", async () => {
    const res = await runPerformance({
      target: srv.url,
      rate: 100,
      duration: "3s",
      scenarios: [{ name: "fast", steps: [{ path: "/fixed/5" }] }],
    });
    const d = res.data!;
    expect(d.model).toBe("open");
    expect(Math.abs(d.totals.requests - 300)).toBeLessThanOrEqual(15);
    expect(Math.abs(d.totals.rps - 100)).toBeLessThanOrEqual(5);
    expect(d.totals.achievedRate).toBeDefined();
    expect(Math.abs((d.totals.achievedRate as number) - 100)).toBeLessThanOrEqual(5);
    expect(d.totals.dropped).toBe(0);
    expect(srv.stats().requests).toBe(d.totals.requests);
  });

  it("deterministic 10% error endpoint → error rate exactly as injected", async () => {
    const res = await runPerformance({
      target: srv.url,
      model: "iterations",
      iterations: 200,
      vus: 4,
      scenarios: [{ name: "err", steps: [{ path: "/error/10" }] }],
      thresholds: { "http.error_rate": "< 5%" },
    });
    const d = res.data!;
    expect(d.totals.requests).toBe(200);
    expect(d.totals.failed).toBe(20);
    expect(d.totals.errorRate).toBeCloseTo(0.1, 6);
    expect(d.errors.find((e) => e.kind === "status")?.count).toBe(20);
    expect(res.status).toBe("failed");
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.classification).toBe("threshold-breach");
    expect(d.thresholds[0]?.actual).toBeCloseTo(0.1, 6);
  });

  it("counts timeouts", async () => {
    const res = await runPerformance({
      target: srv.url,
      model: "iterations",
      iterations: 6,
      vus: 3,
      timeout: "100ms",
      scenarios: [{ name: "slow", steps: [{ path: "/fixed/1000" }] }],
    });
    const d = res.data!;
    expect(d.totals.timeouts).toBe(6);
    expect(d.totals.failed).toBe(6);
    expect(d.errors[0]?.kind).toBe("timeout");
    // latency of timed-out requests ≈ timeout
    expect(d.latency.raw.p50).toBeGreaterThanOrEqual(90);
    expect(d.latency.raw.p50).toBeLessThan(400);
  });

  it("cancellation mid-run returns status cancelled with valid partial data", async () => {
    const ac = new AbortController();
    const events = createEventBus();
    const ticks: unknown[] = [];
    events.on("perf.tick", (p) => ticks.push(p));
    setTimeout(() => ac.abort(), 1500);
    const t = performance.now();
    const res = await runPerformance(
      {
        target: srv.url,
        rate: 50,
        duration: "20s",
        gracefulStop: "1s",
        scenarios: [{ name: "s", steps: [{ path: "/fixed/20" }] }],
      },
      { signal: ac.signal, events },
    );
    const elapsed = performance.now() - t;
    expect(elapsed).toBeLessThan(5000);
    expect(res.status).toBe("cancelled");
    const d = res.data!;
    expect(d.window.stopReason).toBe("cancelled");
    expect(d.totals.requests).toBeGreaterThan(40);
    expect(d.totals.requests).toBeLessThan(100);
    expect(d.window.measuredMs).toBeGreaterThan(1000);
    expect(d.window.measuredMs).toBeLessThan(2500);
    expect(Math.abs(d.totals.rps - 50)).toBeLessThan(8);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
  });

  it("safety denies a public host", async () => {
    await expect(
      runPerformance({ target: "http://example.com", vus: 1, duration: "1s" }),
    ).rejects.toBeInstanceOf(SafetyError);
    expect(srv.stats().requests).toBe(0);
  });

  it("corrected latency reveals a 2 s stall in the open model (coordinated omission)", async () => {
    setTimeout(() => srv.stallFor(1000, { allRoutes: true }), 1000);
    const res = await runPerformance({
      target: srv.url,
      rate: 50,
      duration: "3s",
      scenarios: [{ name: "s", steps: [{ path: "/fixed/2" }] }],
    });
    const d = res.data!;
    // ~50 arrivals queued behind the 1 s stall: corrected p99 ≈ stall, and p90 still elevated
    expect(d.latency.corrected.p99).toBeGreaterThan(700);
    expect(d.latency.corrected.max).toBeGreaterThan(900);
  });
});
