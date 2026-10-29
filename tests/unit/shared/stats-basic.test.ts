import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Reservoir } from "../../../src/shared/stats/reservoir.js";
import { Welford } from "../../../src/shared/stats/welford.js";
import { Ewma, WindowedSeries } from "../../../src/shared/stats/window.js";
import { seeded } from "./_rng.js";

function twoPass(xs: number[]): { mean: number; variance: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.length < 2 ? 0 : xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return { mean, variance };
}

const numsArb = fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 200 });

describe("Welford", () => {
  it("matches two-pass mean/variance", () => {
    fc.assert(
      fc.property(numsArb, (xs) => {
        const w = new Welford();
        for (const x of xs) w.push(x);
        const ref = twoPass(xs);
        expect(w.count).toBe(xs.length);
        expect(w.mean).toBeCloseTo(ref.mean, 4);
        expect(Math.abs(w.variance - ref.variance)).toBeLessThanOrEqual(1e-6 * Math.max(1, ref.variance));
        expect(w.min).toBe(Math.min(...xs));
        expect(w.max).toBe(Math.max(...xs));
      }),
    );
  });

  it("merge equals pushing everything into one", () => {
    fc.assert(
      fc.property(numsArb, numsArb, (a, b) => {
        const wa = new Welford();
        const wb = new Welford();
        const all = new Welford();
        for (const x of a) {
          wa.push(x);
          all.push(x);
        }
        for (const x of b) {
          wb.push(x);
          all.push(x);
        }
        wa.merge(wb);
        expect(wa.count).toBe(all.count);
        expect(wa.mean).toBeCloseTo(all.mean, 4);
        expect(Math.abs(wa.variance - all.variance)).toBeLessThanOrEqual(1e-6 * Math.max(1, all.variance));
      }),
    );
  });

  it("is numerically stable with a large offset", () => {
    const w = new Welford();
    for (const x of [1e9 + 4, 1e9 + 7, 1e9 + 13, 1e9 + 16]) w.push(x);
    expect(w.variance).toBeCloseTo(30, 6);
    const e = new Welford();
    e.merge(w);
    expect(e.variance).toBeCloseTo(30, 6);
    w.reset();
    expect(w.count).toBe(0);
    expect(w.stdDev).toBe(0);
  });
});

describe("Reservoir", () => {
  it("keeps the first k items, then stays at k", () => {
    const r = new Reservoir<number>(3, seeded(1));
    for (let i = 0; i < 3; i++) r.offer(i);
    expect(r.items).toEqual([0, 1, 2]);
    for (let i = 3; i < 100; i++) r.offer(i);
    expect(r.size).toBe(3);
    expect(r.seen).toBe(100);
  });

  it("is deterministic for a fixed seed", () => {
    const a = new Reservoir<number>(5, seeded(42));
    const b = new Reservoir<number>(5, seeded(42));
    for (let i = 0; i < 1000; i++) {
      a.offer(i);
      b.offer(i);
    }
    expect(a.items).toEqual(b.items);
  });

  it("is approximately uniform (chi-square sanity, fixed seed)", () => {
    const N = 20;
    const k = 5;
    const trials = 20000;
    const counts = new Array<number>(N).fill(0);
    const rng = seeded(7);
    for (let t = 0; t < trials; t++) {
      const r = new Reservoir<number>(k, rng);
      for (let i = 0; i < N; i++) r.offer(i);
      for (const x of r.items) counts[x] = (counts[x] ?? 0) + 1;
    }
    const expected = (trials * k) / N;
    const chi2 = counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
    // df = 19; p=0.001 critical value ≈ 43.8
    expect(chi2).toBeLessThan(43.8);
  });
});

describe("WindowedSeries", () => {
  it("assigns records to per-second windows and fills gaps", () => {
    const s = new WindowedSeries({ windowMs: 1000 });
    s.record(100, 1000, true, 10);
    s.record(900, 2000, false, 5);
    s.record(1500, 3000, true);
    s.record(4200, 4000, true); // gap at [2000,3000) and [3000,4000)
    const closed = s.closed();
    expect(closed.map((w) => w.startMs)).toEqual([0, 1000, 2000, 3000]);
    expect(closed[0]?.ok).toBe(1);
    expect(closed[0]?.failed).toBe(1);
    expect(closed[0]?.bytes).toBe(15);
    expect(closed[0]?.summary?.count).toBe(2);
    expect(closed[2]?.summary?.count).toBe(0);
    expect(s.current(4300).startMs).toBe(4000);
    expect(s.total.count).toBe(4);
    expect(s.totalOk).toBe(3);
    expect(s.totalFailed).toBe(1);
  });

  it("clock going backwards stays in the current window", () => {
    const s = new WindowedSeries();
    s.current(5500);
    expect(s.current(5000).startMs).toBe(5000);
    expect(s.current(4000).startMs).toBe(5000);
  });

  it("rolling() merges the last n windows", () => {
    const s = new WindowedSeries();
    for (let t = 0; t < 10; t++) s.record(t * 1000 + 1, (t + 1) * 1000, true);
    s.flush(10_000);
    expect(s.closed()).toHaveLength(10);
    const r = s.rolling(3);
    expect(r.count).toBe(3);
    expect(r.min).toBeGreaterThanOrEqual(7900);
  });

  it("bounded memory: fine ring capped, old histograms compacted, coarse folding", () => {
    const s = new WindowedSeries({
      maxWindows: 100,
      histogramWindows: 10,
      foldFactor: 60,
      maxCoarseWindows: 5,
    });
    for (let t = 0; t < 1000; t++) s.record(t * 1000, 500, t % 10 !== 0, 1);
    s.closeAll();
    const closed = s.closed();
    expect(closed).toHaveLength(100);
    expect(closed.filter((w) => w.histogram !== null).length).toBeLessThanOrEqual(10);
    expect(closed.every((w) => w.summary !== null)).toBe(true);
    const coarse = s.coarse();
    expect(coarse.length).toBeLessThanOrEqual(6);
    const last = coarse[coarse.length - 1];
    expect(last?.startMs).toBe(960_000);
    expect(last?.ok).toBe(36);
    expect(last?.failed).toBe(4);
    const full = coarse[coarse.length - 2];
    expect((full?.ok ?? 0) + (full?.failed ?? 0)).toBe(60);
    expect(s.total.count).toBe(1000);
    expect(s.totalBytes).toBe(1000);
  });

  it("huge gaps are bounded by maxWindows", () => {
    const s = new WindowedSeries({ maxWindows: 50 });
    s.record(0, 1, true);
    s.record(10_000_000, 1, true);
    expect(s.closed().length).toBeLessThanOrEqual(50);
    expect(s.current(10_000_000).startMs).toBe(10_000_000);
  });
});

describe("Ewma", () => {
  it("first sample initialises, then α = 1 − e^(−Δt/τ)", () => {
    const e = new Ewma(1000);
    expect(e.update(10, 0)).toBe(10);
    const a = 1 - Math.exp(-1);
    expect(e.update(20, 1000)).toBeCloseTo(10 + a * 10, 10);
    expect(e.initialized).toBe(true);
  });

  it("Δt = 0 does not move the value; long gaps converge to x", () => {
    const e = new Ewma(100);
    e.update(5, 0);
    expect(e.update(100, 0)).toBe(5);
    expect(e.update(100, 1_000_000)).toBeCloseTo(100, 6);
    expect(() => new Ewma(0)).toThrow();
  });

  it("irregular ticks equal regular ticks for a constant input", () => {
    const e = new Ewma(500);
    e.update(0, 0);
    e.update(1, 100);
    e.update(1, 1000);
    const f = new Ewma(500);
    f.update(0, 0);
    f.update(1, 1000);
    expect(e.value).toBeCloseTo(f.value, 10);
  });
});
