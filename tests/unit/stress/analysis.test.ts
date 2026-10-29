import { describe, expect, it } from "vitest";
import { createRng } from "../../../src/core/rng.js";
import {
  applySaturationInvalidation,
  findKnee,
  firstBreach,
  fitUsl,
  senSlopeCI,
  soakDrift,
  spikeRecovery,
  testedCapacity,
  uslThroughput,
} from "../../../src/engines/stress/index.js";
import type { StageSeriesPoint } from "../../../src/engines/stress/types.js";
import { stage } from "./fake.js";

const withIdx = <T extends { index: number }>(xs: T[]): T[] => xs.map((x, i) => ({ ...x, index: i }));

describe("stress analysis", () => {
  it("knee: flat then steep latency curve → knee at the bend", () => {
    const levels = [10, 20, 30, 40, 50, 60, 70, 80];
    const st = withIdx(levels.map((l) => stage(l, l <= 50 ? 10 + l * 0.02 : 10 + (l - 50) * 5)));
    const k = findKnee(st);
    expect(k).not.toBeNull();
    expect(k?.level).toBeGreaterThanOrEqual(50);
    expect(k?.level).toBeLessThanOrEqual(60);
  });

  it("first breach + tested capacity (conservative: pass above a fail is ignored)", () => {
    const st = withIdx([
      stage(10, 10),
      stage(20, 12),
      stage(30, 60, {
        status: "breached",
        breachReasons: ["p95<50ms"],
        thresholds: [
          { expression: "p95<50ms", metric: "http.p95", actual: 60, threshold: 50, passed: false },
        ],
      }),
      stage(40, 45), // noisy pass above the breach
    ]);
    const fb = firstBreach(st);
    expect(fb).toMatchObject({ level: 30, metric: "http.p95", actual: 60, threshold: 50 });
    const cap = testedCapacity(st, "vus");
    expect(cap.testedCapacity).toBe(20);
    expect(cap.statement).toMatch(/Highest tested load/);
    expect(cap.statement).not.toMatch(/max(imum)? capacity is/i);
  });

  it("generator saturation invalidates conclusions from that stage onward", () => {
    const st = withIdx([
      stage(10, 10),
      stage(20, 11),
      stage(30, 12, {
        generator: { saturated: true, reasons: ["cpu"], cpuPercent: 99, eventLoopDelayP99Ms: 50 },
      }),
      stage(40, 80, { status: "breached", breachReasons: ["p95<50ms"] }),
    ]);
    expect(applySaturationInvalidation(st)).toBe(2);
    expect(st.map((s) => s.invalid)).toEqual([false, false, true, true]);
    expect(firstBreach(st)).toBeNull();
    expect(testedCapacity(st, "vus").testedCapacity).toBe(20);
  });

  it("spike recovery: rolling p95 back within 10% for 3 windows", () => {
    const series = (ps: number[]): StageSeriesPoint[] =>
      ps.map((p, t) => ({ t, requests: 10, failed: 0, rps: 10, p95: p, p99: p }));
    const before = stage(5, 20, {
      kind: "spike-before",
      series: series([20, 20, 21, 19, 20]),
      startMs: 0,
      holdMs: 5000,
    });
    const peak = stage(50, 400, { kind: "spike-peak", startMs: 5000, holdMs: 3000 });
    // after starts 500 ms after spike end; recovered windows start at t=4
    const after = stage(5, 30, {
      kind: "spike-after",
      startMs: 8500,
      series: series([300, 200, 80, 21, 21, 21.5, 30, 20]),
    });
    const r = spikeRecovery(before, peak, after);
    expect(r.baselineP95).toBe(20);
    expect(r.recovered).toBe(true);
    expect(r.recoveryTimeS).toBeCloseTo(0.5 + 3, 6);
    const never = spikeRecovery(before, peak, { ...after, series: series([300, 200, 100, 90, 80]) });
    expect(never.recovered).toBe(false);
    expect(never.recoveryTimeS).toBeNull();
  });

  it("soak drift: Theil–Sen slope recovers a known drift with CI excluding 0; flat → no drift", () => {
    const rng = createRng(7);
    const drifting: StageSeriesPoint[] = [];
    const flat: StageSeriesPoint[] = [];
    for (let t = 0; t < 1800; t++) {
      const noise = (rng.next() - 0.5) * 4;
      // +36 ms/h = 0.01 ms/s; 5% spikes as outliers
      const out = rng.next() < 0.05 ? 200 : 0;
      drifting.push({ t, requests: 50, failed: 0, rps: 50, p95: 20 + 0.01 * t + noise + out, p99: 0 });
      flat.push({ t, requests: 50, failed: 0, rps: 50, p95: 20 + noise, p99: 0 });
    }
    const d = soakDrift(drifting, 10_000);
    expect(d.points).toBe(180);
    expect(d.p95SlopeMsPerHour).toBeGreaterThan(25);
    expect(d.p95SlopeMsPerHour).toBeLessThan(50);
    expect(d.drift).toBe(true);
    expect(d.ci95![0]).toBeGreaterThan(0);
    const f = soakDrift(flat, 10_000);
    expect(f.drift).toBe(false);
  });

  it("soak CUSUM flags a sudden step change", () => {
    const pts: StageSeriesPoint[] = [];
    for (let t = 0; t < 600; t++)
      pts.push({ t, requests: 10, failed: 0, rps: 10, p95: (t < 300 ? 20 : 40) + ((t * 7) % 3), p99: 0 });
    const d = soakDrift(pts, 10_000);
    expect(d.changePoints.length).toBeGreaterThan(0);
    expect(d.changePoints[0]!.direction).toBe("up");
    expect(d.changePoints[0]!.t).toBeGreaterThanOrEqual(300);
  });

  it("Sen CI brackets the slope", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    const ys = xs.map((x) => 2 * x + ((x * 13) % 5));
    const ci = senSlopeCI(xs, ys)!;
    expect(ci[0]).toBeLessThanOrEqual(2);
    expect(ci[1]).toBeGreaterThanOrEqual(2);
  });

  it("USL: recovers synthetic parameters (estimate); refuses < 5 points and poor fits", () => {
    const ns = [1, 2, 4, 8, 16, 32, 64];
    const pts = ns.map((n) => ({ n, x: uslThroughput(n, 100, 0.05, 0.001) }));
    const u = fitUsl(pts, "vus");
    expect(u.kind).toBe("estimate");
    expect(u.refused).toBeUndefined();
    expect(u.r2!).toBeGreaterThan(0.99);
    expect(u.sigma!).toBeCloseTo(0.05, 1);
    expect(u.peakN!).toBeGreaterThan(20);
    expect(u.peakN!).toBeLessThan(40);
    expect(fitUsl(pts.slice(0, 4), "vus").refused).toMatch(/at least 5/);
    const noisy = ns.map((n, i) => ({ n, x: i % 2 === 0 ? 1000 : 10 }));
    expect(fitUsl(noisy, "vus").refused).toMatch(/R²/);
  });
});
