/**
 * Stress & Capacity Lab against the calibrated fixture's /capacity/:n route
 * (n workers, service time ms, FIFO queue beyond n → known capacity cliff).
 *
 * Retries: these tests measure real load. When the whole suite runs in parallel, CPU contention can
 * make the Performance Lab self-check flag generator saturation; stress then (correctly) refuses
 * conclusions from that stage. A retry re-measures; a genuine regression fails all attempts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import { renderReport } from "../../../src/engines/reporting/index.js";
import { runStress } from "../../../src/engines/stress/index.js";
import { type ChildServer, startChildServer } from "./child-server.js";

let srv: ChildServer;
beforeEach(async () => {
  srv = await startChildServer();
});
afterEach(async () => {
  await srv.close();
});

describe("stress lab (integration)", () => {
  it("step (VUs): first breach exactly at the stage past the cliff", {
    timeout: 20_000,
    retry: 2,
  }, async () => {
    // 8 workers × 20 ms: ≤ 8 VUs → ~20 ms; 16 VUs → ~40 ms; 32 VUs → ~80 ms.
    const r = await runStress({
      target: `${srv.url}/capacity/8?ms=20`,
      stages: [2, 4, 8, 16, 32],
      hold: "1500ms",
      settle: "300ms",
      thresholds: { "http.p95": "< 32ms" },
      stopWhen: { continueAfterBreach: 1 },
    });
    const d = r.data!;
    expect(d.stages.map((s) => s.level)).toEqual([2, 4, 8, 16, 32]);
    expect(d.firstBreach?.level).toBe(16);
    expect(d.firstBreach?.metric).toBe("http.p95");
    expect(d.capacity.testedCapacity).toBe(8);
    expect(d.stages[2]!.latency.p95).toBeLessThan(30);
    expect(d.stages[3]!.latency.p50).toBeGreaterThan(32);
    // throughput saturates near 8 × 1000/20 = 400 rps
    expect(d.stages[4]!.throughput).toBeLessThan(440);
    expect(r.status).toBe("failed");
    expect(r.findings.some((f) => f.ruleId === "STRESS-FIRST-BREACH")).toBe(true);
  });

  it("breakpoint (VUs) with bisection pins the latency cliff", { timeout: 20_000, retry: 2 }, async () => {
    // 4 workers × 40 ms, closed loop: queueing quantises latency to ceil(VUs/4) × 40 ms, so p95 is
    // ~80 ms at 8 VUs and ~120 ms at 9 VUs. Threshold 105 ms → true boundary 8 | 9 with wide margins.
    // Closed model on purpose: the open-model scheduling-lag self-check trips under CPU contention
    // when suites run in parallel.
    const r = await runStress({
      target: `${srv.url}/capacity/4?ms=40`,
      mode: "breakpoint",
      hold: "1s",
      settle: "300ms",
      breakpoint: { from: 2, to: 18, step: 8, minStep: 1 },
      thresholds: { "http.p95": "< 105ms" },
    });
    const d = r.data!;
    expect(d.loadType).toBe("vus");
    expect(d.stopReason).toBe("breach");
    const bp = d.breakpoint!;
    // coarse ladder 2, 10, 18 → bisection between 10 and 18 (≤ ⌈log2(8/1)⌉ = 3 extra stages)
    expect(bp.bisectionStages).toBeGreaterThanOrEqual(1);
    expect(bp.bisectionStages).toBeLessThanOrEqual(3);
    expect(bp.converged).toBe(true);
    expect(bp.firstFail! - bp.lastPass!).toBeLessThanOrEqual(1);
    expect(bp.lastPass).toBe(8);
    expect(bp.firstFail).toBe(9);
    expect(d.capacity.testedCapacity).toBe(bp.lastPass);
  });

  it("spike: measures recovery after the spike", { timeout: 20_000, retry: 2 }, async () => {
    const r = await runStress({
      target: `${srv.url}/capacity/4?ms=10`,
      mode: "spike",
      hold: "2s",
      spike: { baseline: 2, peak: 40, duration: "2s", after: "4s" },
      thresholds: { "http.p95": "< 30ms" },
    });
    const d = r.data!;
    expect(d.stages.map((s) => s.kind)).toEqual(["spike-before", "spike-peak", "spike-after"]);
    expect(d.stages[1]!.latency.p95).toBeGreaterThan(60);
    expect(d.spike!.baselineP95!).toBeLessThan(20);
    expect(d.spike!.recovered).toBe(true);
    expect(d.spike!.recoveryTimeS!).toBeGreaterThanOrEqual(0);
    expect(d.spike!.recoveryTimeS!).toBeLessThan(3);
    expect(r.findings.some((f) => f.ruleId === "STRESS-SPIKE-RECOVERY")).toBe(true);
  });
  it("safety.maxRps 200 caps the stages: marked capped, limitation present, statement names the cap", {
    timeout: 20_000,
  }, async () => {
    const ac = new AbortController();
    const safety = createSafetyGuard({ maxRps: 200 }, { interactive: false, signal: ac.signal });
    // /fixed/5 with 4-8 VUs would reach ~600-1500 rps uncapped.
    const r = await runStress(
      {
        target: `${srv.url}/fixed/5`,
        stages: [4, 8],
        hold: "2s",
        settle: "300ms", // absorbs the GCRA burst (ceil(maxRps/10) cells per fresh lease) before measuring
        thresholds: { "http.p95": "< 1000ms" },
      },
      { safety },
    );
    const d = r.data!;
    expect(d.stages.map((s) => s.capped)).toEqual([true, true]);
    for (const s of d.stages) {
      expect(s.throttled).toBeGreaterThan(0);
      expect(s.capRps).toBe(200);
      expect(s.throughput).toBeGreaterThan(190);
      expect(s.throughput).toBeLessThanOrEqual(202);
    }
    const lim = r.limitations.find((l) => l.code === "STRESS-SAFETY-RATE-CAP");
    expect(lim?.impact).toBe("invalidates");
    expect(d.capacity.limitedBySafetyCap).toBe(true);
    expect(d.capacity.statement).toMatch(
      /limited by safety\.maxRps 200 req\/s; the target's capacity was not reached/,
    );
    const md = renderReport([r], "md");
    expect(md).toContain("CAPPED");
    expect(md).toContain("STRESS-SAFETY-RATE-CAP");
  });
});
