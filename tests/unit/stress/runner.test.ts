import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../src/core/clock.js";
import { createEventBus } from "../../../src/core/events.js";
import { runStress } from "../../../src/engines/stress/index.js";
import { fakeRunner } from "./fake.js";

const T = "http://127.0.0.1:1";
// Latency cliff above 50: p95 = 10 ms until 50, then +5 ms per unit.
const cliff = { p95: (l: number) => (l <= 50 ? 10 : 10 + (l - 50) * 5) };

describe("stress runner (fake stages)", () => {
  it("step: stops at the first breaching stage, reports capacity, knee and findings", async () => {
    const calls: Record<string, unknown>[] = [];
    const r = await runStress(
      {
        target: T,
        stages: [10, 20, 30, 40, 50, 60, 70, 80],
        hold: "2s",
        settle: "1s",
        warmup: "3s",
        thresholds: { "http.p95": "<40ms" },
      },
      {},
      { runStage: fakeRunner(cliff, calls) },
    );
    const d = r.data!;
    expect(d.stages.map((s) => s.level)).toEqual([10, 20, 30, 40, 50, 60]);
    expect(d.stopReason).toBe("breach");
    expect(d.firstBreach).toMatchObject({ level: 60, metric: "http.p95", actual: 60 });
    expect(d.capacity.testedCapacity).toBe(50);
    expect(r.status).toBe("failed");
    expect(r.findings.map((f) => f.ruleId)).toContain("STRESS-FIRST-BREACH");
    const fb = r.findings.find((f) => f.ruleId === "STRESS-FIRST-BREACH")!;
    expect(fb.classification).toBe("threshold-breach");
    // per-stage perf input: closed model, settle → warm-up, base warm-up only first stage
    expect(calls[0]).toMatchObject({ model: "closed", vus: 10, duration: 2000, warmup: 4000, rampUp: 0 });
    expect(calls[1]).toMatchObject({ vus: 20, warmup: 1000 });
  });

  it("continueAfterBreach runs extra stages so the knee is visible", async () => {
    const r = await runStress(
      {
        target: T,
        stages: [10, 20, 30, 40, 50, 60, 70, 80],
        hold: "1s",
        thresholds: { "http.p95": "<40ms" },
        stopWhen: { continueAfterBreach: 2 },
      },
      {},
      { runStage: fakeRunner(cliff) },
    );
    expect(r.data!.stages.map((s) => s.level)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(r.data!.knee?.level).toBeGreaterThanOrEqual(50);
    expect(r.data!.knee?.level).toBeLessThanOrEqual(60);
    expect(r.findings.some((f) => f.ruleId === "STRESS-KNEE" && f.classification === "observation")).toBe(
      true,
    );
  });

  it("breakpoint: bisection refines the boundary in O(log range) stages", async () => {
    // fails when level > 137
    const r = await runStress(
      {
        target: T,
        rate: 1,
        mode: "breakpoint",
        hold: "1s",
        breakpoint: { from: 50, to: 400, step: 50, minStep: 5 },
        thresholds: { "http.p95": "<100ms" },
      },
      {},
      { runStage: fakeRunner({ p95: (l) => (l > 137 ? 500 : 20) }) },
    );
    const d = r.data!;
    expect(d.loadType).toBe("rate");
    expect(d.breakpoint).toBeDefined();
    expect(d.breakpoint!.lastPass).toBeLessThanOrEqual(137);
    expect(d.breakpoint!.firstFail).toBeGreaterThan(137);
    expect(d.breakpoint!.firstFail! - d.breakpoint!.lastPass!).toBeLessThanOrEqual(5);
    expect(d.breakpoint!.converged).toBe(true);
    expect(d.breakpoint!.bisectionStages).toBeLessThanOrEqual(Math.ceil(Math.log2(50 / 5)) + 1);
    expect(d.capacity.testedCapacity).toBe(d.breakpoint!.lastPass);
    expect(r.status).toBe("passed"); // breakpoint: breach is the expected outcome
    expect(r.findings.find((f) => f.ruleId === "STRESS-FIRST-BREACH")?.severity).toBe("low");
  });

  it("generator saturation stops and invalidates with a Limitation", async () => {
    const r = await runStress(
      { target: T, stages: [10, 20, 30, 40], hold: "1s", thresholds: { "http.p95": "<100ms" } },
      {},
      { runStage: fakeRunner({ p95: () => 10, saturated: (l) => l >= 30 }) },
    );
    const d = r.data!;
    expect(d.stopReason).toBe("saturation");
    expect(d.stages).toHaveLength(3);
    expect(d.invalidFromStage).toBe(2);
    expect(d.capacity.testedCapacity).toBe(20);
    expect(r.limitations.find((l) => l.code === "STRESS-GENERATOR-SATURATED")?.impact).toBe("invalidates");
  });

  it("error-rate stop condition and missing-threshold limitation", async () => {
    const r = await runStress(
      { target: T, stages: [10, 20, 30], hold: "1s", stopWhen: { errorRate: 0.1 } },
      {},
      { runStage: fakeRunner({ p95: () => 10, errorRate: (l) => (l >= 20 ? 0.3 : 0) }) },
    );
    expect(r.data!.stages).toHaveLength(2);
    expect(["breach", "error-rate"]).toContain(r.data!.stopReason);
    expect(r.data!.firstBreach?.metric).toBe("http.error_rate");
    expect(r.limitations.some((l) => l.code === "STRESS-NO-THRESHOLDS")).toBe(true);
  });

  it("budget: limits.maxDuration prevents a stage from starting", async () => {
    const clock = createFakeClock(0);
    const r = await runStress(
      { target: T, stages: [1, 2, 3], hold: "2s", limits: { maxDuration: "3s" } },
      { clock },
      {
        runStage: async (i, c, d) => {
          clock.advance(i.duration as number);
          return fakeRunner({ p95: () => 1 })(i, c, d);
        },
      },
    );
    expect(r.data!.stopReason).toBe("budget");
    expect(r.data!.stages).toHaveLength(1);
  });

  it("cancel before start → cancelled, no stages", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runStress(
      { target: T, stages: [1, 2] },
      { signal: ac.signal },
      { runStage: fakeRunner({ p95: () => 1 }) },
    );
    expect(r.status).toBe("cancelled");
    expect(r.data!.stages).toHaveLength(0);
  });

  it("spike: runs all three stages despite the breach and reports recovery", async () => {
    const r = await runStress(
      {
        target: T,
        mode: "spike",
        hold: "3s",
        spike: { baseline: 5, peak: 50, duration: "2s", after: "6s" },
        thresholds: { "http.p95": "<50ms" },
      },
      {},
      {
        runStage: fakeRunner({
          p95: (l) => (l > 10 ? 300 : 20),
          series: (_l, holdS, idx) =>
            idx === 2
              ? [200, 100, 20, 20, 21, 20].slice(0, holdS)
              : Array.from({ length: holdS }, () => (idx === 1 ? 300 : 20)),
        }),
      },
    );
    const d = r.data!;
    expect(d.stages.map((s) => s.kind)).toEqual(["spike-before", "spike-peak", "spike-after"]);
    expect(d.spike?.recovered).toBe(true);
    expect(d.spike?.recoveryTimeS).toBeGreaterThanOrEqual(2);
    expect(d.capacity.testedCapacity).toBeNull();
    expect(r.findings.some((f) => f.ruleId === "STRESS-SPIKE-RECOVERY")).toBe(true);
  });

  it("window-level abort after k consecutive breaching ticks", async () => {
    const events = createEventBus();
    const r = await runStress(
      {
        target: T,
        stages: [10, 20],
        hold: "1s",
        thresholds: { "http.p95": "<40ms" },
        stopWhen: { consecutiveWindows: 3 },
      },
      { events },
      {
        runStage: async (input, ctx, deps) => {
          const level = input.vus as number;
          for (let i = 1; i <= 5 && !ctx.signal?.aborted; i++) {
            events.emit("perf.tick", {
              phase: "measure",
              p95: level === 20 ? 90 : 10,
              p99: 0,
              requests: i * 10,
              totalErrors: 0,
            });
          }
          const res = await fakeRunner({ p95: () => 10 })(input, ctx, deps);
          return ctx.signal?.aborted ? { ...res, status: "cancelled" } : res;
        },
      },
    );
    const s2 = r.data!.stages[1]!;
    expect(s2.abortedEarly).toBe(true);
    expect(s2.status).toBe("breached");
    expect(s2.breachReasons[0]).toMatch(/consecutive/);
    expect(r.status).toBe("failed");
  });
  describe("safety rate cap (PERF-THROTTLED-BY-SAFETY)", () => {
    const steps = [10, 20, 30, 40, 50, 60, 70, 80];

    it("capped stages invalidate the capacity statement and suppress knee/USL", async () => {
      // throughput = 10 × VUs, capped at 500 req/s → stages > 50 VUs are throttled.
      const r = await runStress(
        { target: T, stages: steps, hold: "1s", thresholds: { "http.p95": "< 1000ms" } },
        {},
        { runStage: fakeRunner({ ...cliff, capRps: 500 }) },
      );
      const d = r.data!;
      expect(d.stages.filter((s) => s.capped).map((s) => s.level)).toEqual([60, 70, 80]);
      expect(d.stages.find((s) => s.level === 60)?.capRps).toBe(500);
      expect(d.capacity.testedCapacity).toBe(80);
      expect(d.capacity.limitedBySafetyCap).toBe(true);
      expect(d.capacity.statement).toMatch(
        /limited by safety\.maxRps 500 req\/s; the target's capacity was not reached/,
      );
      const lim = r.limitations.find((l) => l.code === "STRESS-SAFETY-RATE-CAP");
      expect(lim?.impact).toBe("invalidates");
      expect(lim?.message).toMatch(/safety\.maxRps 500 req\/s/);
      expect(d.safetyCap).toEqual({ rps: 500, cappedStages: [5, 6, 7], impact: "invalidates" });
      // Without the cap the cliff gives a knee around 50-60 VUs; from uncapped stages (flat p95) none is reported.
      expect(d.knee).toBeNull();
      expect(d.notes?.[0]).toMatch(/uncapped stage\(s\) only; 3 stage\(s\) throttled/);
      expect(d.usl?.points).toBe(5);
      expect(r.findings.some((f) => f.ruleId === "STRESS-KNEE")).toBe(false);
    });

    it("budget.maxRps as the binding cap is named as such", async () => {
      const r = await runStress(
        { target: T, stages: [10, 60], hold: "1s", budget: { maxRps: 500 } },
        {},
        { runStage: fakeRunner({ p95: () => 10, capRps: 500 }) },
      );
      expect(r.data!.capacity.statement).toMatch(/budget\.maxRps 500 req\/s/);
    });

    it("a capped stage below the knee and away from the capacity stage only reduces confidence", async () => {
      const r = await runStress(
        { target: T, stages: [10, 20, 30, 40, 50, 60], hold: "1s", thresholds: { "http.p95": "< 40ms" } },
        {},
        { runStage: fakeRunner({ ...cliff, throughput: (l) => (l === 20 ? 900 : l * 10), capRps: 800 }) },
      );
      const d = r.data!;
      expect(d.stages.filter((s) => s.capped).map((s) => s.level)).toEqual([20]);
      expect(d.capacity.testedCapacity).toBe(50);
      expect(d.capacity.limitedBySafetyCap).toBeUndefined();
      expect(r.limitations.find((l) => l.code === "STRESS-SAFETY-RATE-CAP")?.impact).toBe(
        "reduces-confidence",
      );
    });

    it("breakpoint mode stops at the cap with stop reason safety-cap", async () => {
      const r = await runStress(
        {
          target: T,
          mode: "breakpoint",
          hold: "1s",
          breakpoint: { from: 20, to: 100, step: 20 },
          thresholds: { "http.p95": "< 1000ms" },
        },
        {},
        { runStage: fakeRunner({ p95: () => 10, capRps: 500 }) },
      );
      expect(r.data!.stopReason).toBe("safety-cap");
      expect(r.data!.stages.map((s) => s.level)).toEqual([20, 40, 60]);
      expect(r.data!.breakpoint?.firstFail).toBeNull();
    });

    it("no cap → no limitation, no safetyCap block", async () => {
      const r = await runStress(
        { target: T, stages: [10, 20], hold: "1s" },
        {},
        { runStage: fakeRunner({ p95: () => 10 }) },
      );
      expect(r.data!.safetyCap).toBeUndefined();
      expect(r.data!.stages.every((s) => !s.capped && !s.throttled)).toBe(true);
      expect(r.limitations.some((l) => l.code === "STRESS-SAFETY-RATE-CAP")).toBe(false);
    });
  });
});
