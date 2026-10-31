/**
 * Property tests for the shared statistics primitives (docs/04-data-structures-and-algorithms.md
 * §3.5, §4.2–4.5, §6.6): invariants, round-trips and edge branches. Owner: sw-coverage (Wave 5).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cusum, mad, madOutliers, madZ } from "../../../src/shared/stats/anomaly.js";
import { LatencyHistogram } from "../../../src/shared/stats/hdr.js";
import { kneedle } from "../../../src/shared/stats/knee.js";
import { wilson } from "../../../src/shared/stats/proportion.js";
import {
  mean,
  median,
  normalCdf,
  normalQuantile,
  quantile,
  sortedCopy,
} from "../../../src/shared/stats/quantile.js";
import { theilSen } from "../../../src/shared/stats/regression.js";
import { Reservoir } from "../../../src/shared/stats/reservoir.js";
import { Welford } from "../../../src/shared/stats/welford.js";

const finite = fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });
const sample = fc.array(finite, { minLength: 1, maxLength: 60 });

describe("quantile", () => {
  it("property: within [min, max], monotone in q, nearest-rank returns a sample element", () => {
    fc.assert(
      fc.property(
        sample,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (xs, q1, q2) => {
          const s = sortedCopy(xs);
          const [lo, hi] = q1 <= q2 ? [q1, q2] : [q2, q1];
          for (const m of ["type7", "nearest-rank"] as const) {
            const a = quantile(s, lo, m);
            const b = quantile(s, hi, m);
            expect(a).toBeLessThanOrEqual(b + 1e-9);
            expect(a).toBeGreaterThanOrEqual((s[0] as number) - 1e-9);
            expect(b).toBeLessThanOrEqual((s[s.length - 1] as number) + 1e-9);
          }
          expect(Array.from(s)).toContain(quantile(s, q1, "nearest-rank"));
        },
      ),
    );
  });

  it("edges: empty, out-of-range q, mean/median", () => {
    expect(quantile([], 0.5)).toBeNaN();
    expect(quantile([1, 2, 3], -1)).toBe(1);
    expect(quantile([1, 2, 3], 7)).toBe(3);
    expect(quantile([5], 0.3, "nearest-rank")).toBe(5);
    expect(mean([])).toBeNaN();
    expect(median([3, 1, 2])).toBe(2);
  });

  it("property: normalCdf ∘ normalQuantile ≈ identity; tails are infinite", () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-6, max: 1 - 1e-6, noNaN: true }), (p) => {
        expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 5);
      }),
    );
    expect(normalQuantile(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(normalQuantile(1)).toBe(Number.POSITIVE_INFINITY);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 8);
    expect(normalCdf(-40)).toBeGreaterThanOrEqual(0);
  });
});

describe("Welford", () => {
  it("property: merging partitions equals a single pass; matches the two-pass formulas", () => {
    fc.assert(
      fc.property(fc.array(finite, { maxLength: 50 }), fc.array(finite, { maxLength: 50 }), (a, b) => {
        const all = new Welford();
        const wa = new Welford();
        const wb = new Welford();
        for (const x of a) all.push(x), wa.push(x);
        for (const x of b) all.push(x), wb.push(x);
        wa.merge(wb);
        const xs = [...a, ...b];
        expect(wa.count).toBe(xs.length);
        expect(wa.mean).toBeCloseTo(all.mean, 3);
        expect(wa.variance).toBeCloseTo(all.variance, -1);
        if (xs.length > 0) {
          expect(wa.min).toBe(Math.min(...xs));
          expect(wa.max).toBe(Math.max(...xs));
          const m = xs.reduce((s, x) => s + x, 0) / xs.length;
          expect(all.populationVariance).toBeCloseTo(
            xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length,
            -2,
          );
        }
      }),
    );
  });

  it("empty and merge-into-empty", () => {
    const w = new Welford();
    expect([w.mean, w.variance, w.populationVariance, w.min, w.max, w.stdDev]).toEqual([0, 0, 0, 0, 0, 0]);
    const o = new Welford();
    o.push(4);
    o.push(6);
    w.merge(o);
    w.merge(new Welford());
    expect([w.count, w.mean, w.min, w.max]).toEqual([2, 5, 4, 6]);
    w.reset();
    expect(w.count).toBe(0);
  });
});

describe("Reservoir", () => {
  it("property: never more than k items, all items come from the stream, seen counts every offer", () => {
    fc.assert(
      fc.property(
        fc.nat(10),
        fc.array(fc.integer(), { maxLength: 100 }),
        fc.double({ min: 0, max: 0.999999, noNaN: true }),
        (k, xs, r) => {
          const res = new Reservoir<number>(k, () => r);
          for (const x of xs) res.offer(x);
          expect(res.size).toBe(Math.min(k, xs.length));
          expect(res.seen).toBe(xs.length);
          for (const it of res.items) expect(xs).toContain(it);
        },
      ),
    );
    expect(() => new Reservoir(-1, Math.random)).toThrow(RangeError);
    expect(() => new Reservoir(1.5, Math.random)).toThrow(RangeError);
    const zero = new Reservoir<number>(0, () => 0);
    expect(zero.offer(1)).toBe(false);
    zero.reset();
    expect(zero.seen).toBe(0);
  });
});

describe("LatencyHistogram", () => {
  it("property: percentiles are within the configured relative error of the exact nearest-rank value", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10_000_000 }), { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 1, max: 100 }),
        (xs, q) => {
          const h = new LatencyHistogram({ digits: 3 });
          for (const x of xs) h.record(x);
          const exact = quantile(sortedCopy(xs), q / 100, "nearest-rank");
          expect(Math.abs(h.percentile(q) - exact)).toBeLessThanOrEqual(exact * 1e-3 + 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("property: encode/decode and add are lossless", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5_000_000 }), { maxLength: 100 }),
        fc.array(fc.integer({ min: 0, max: 5_000_000 }), { maxLength: 100 }),
        (a, b) => {
          const ha = new LatencyHistogram();
          const hb = new LatencyHistogram();
          const hall = new LatencyHistogram();
          for (const x of a) ha.record(x), hall.record(x);
          for (const x of b) hb.record(x), hall.record(x);
          ha.add(hb);
          // Bucket-wise merges keep counts and percentiles exact; max/mean may move to the
          // bucket's highest-equivalent value (HdrHistogram add semantics), i.e. within 0.1 %.
          const same = (x: LatencyHistogram) => {
            const s = x.summary();
            const t = hall.summary();
            expect([s.count, s.min, s.p50, s.p90, s.p99, s.p999]).toEqual([
              t.count,
              t.min,
              t.p50,
              t.p90,
              t.p99,
              t.p999,
            ]);
            expect(Math.abs(s.max - t.max)).toBeLessThanOrEqual(t.max * 1e-3 + 1);
            expect(Math.abs(s.mean - t.mean)).toBeLessThanOrEqual(t.mean * 1e-3 + 1);
          };
          same(ha);
          same(LatencyHistogram.decode(hall.encode()));
          same(hall.clone());
        },
      ),
      { numRuns: 50 },
    );
  });

  it("clamps negative/NaN/too-large values and counts them; empty stats are 0", () => {
    const h = new LatencyHistogram({ highestUs: 1000 });
    expect([h.percentile(50), h.min, h.max, h.mean, h.stdDev]).toEqual([0, 0, 0, 0, 0]);
    h.record(-5);
    h.record(Number.NaN);
    h.record(5000);
    h.recordCount(10, 0);
    h.recordCount(10, 2.7);
    h.recordCorrected(100, 0);
    expect(h.clamped).toBe(3);
    expect(h.count).toBe(6);
    expect(h.max).toBeLessThanOrEqual(1001);
    const empty = new LatencyHistogram();
    empty.clamped = 2;
    h.add(empty);
    expect(h.clamped).toBe(5);
    const big = new LatencyHistogram();
    big.record(3_000_000_000);
    expect(() => h.add(big)).toThrow(RangeError);
    expect(h.footprintBytes).toBeGreaterThan(0);
    h.reset();
    expect([h.count, h.clamped]).toEqual([0, 0]);
  });

  it("coordinated-omission correction back-fills missed intervals", () => {
    const h = new LatencyHistogram();
    h.recordCorrected(10_000, 1_000);
    expect(h.count).toBe(10);
    expect(h.min).toBeLessThanOrEqual(1_001);
  });
});

describe("robust statistics", () => {
  it("property: MAD is non-negative, shift-invariant, and scales with |c|", () => {
    fc.assert(
      fc.property(sample, fc.double({ min: -100, max: 100, noNaN: true }), (xs, c) => {
        const m = mad(xs);
        expect(m).toBeGreaterThanOrEqual(0);
        expect(mad(xs.map((x) => x + c))).toBeCloseTo(m, 2);
        expect(mad(xs.map((x) => x * c))).toBeCloseTo(m * Math.abs(c), -1);
      }),
    );
    expect(mad([])).toBeNaN();
    expect(madZ([1, 1, 1]).every((z) => z === 0 || Number.isFinite(z) || Number.isNaN(z))).toBe(true);
    expect(madOutliers([1, 1, 1, 1, 100])).toContain(4);
  });

  it("cusum detects an upward step, not a flat series; constant baseline uses fallbacks", () => {
    const step = [...Array(30).fill(10), ...Array(20).fill(20)].map((x, i) => x + (i % 3) * 0.1);
    const r = cusum(step, { warmup: 30 });
    expect(r.signals.length).toBeGreaterThan(0);
    expect(r.signals[0]?.index).toBeGreaterThanOrEqual(30);
    expect(cusum(Array(40).fill(5)).signals).toEqual([]);
    const flatThenJump = cusum([...Array(10).fill(1), 2, 2, 2], { warmup: 10 });
    expect(flatThenJump.signals.length).toBeGreaterThan(0);
    expect(cusum([]).signals).toEqual([]);
    expect(cusum([1, 2, 3], { mean: 2, std: 1, resetOnSignal: false }).signals).toEqual([]);
  });

  it("property: Wilson interval contains p̂, lies in [0,1], narrows with n", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), fc.double({ min: 0, max: 1, noNaN: true }), (n, f) => {
        const k = Math.round(f * n);
        const w = wilson(k, n);
        expect(w.lower).toBeLessThanOrEqual(w.p + 1e-12);
        expect(w.upper).toBeGreaterThanOrEqual(w.p - 1e-12);
        expect(w.lower).toBeGreaterThanOrEqual(0);
        expect(w.upper).toBeLessThanOrEqual(1);
        const w4 = wilson(k * 4, n * 4);
        expect(w4.upper - w4.lower).toBeLessThanOrEqual(w.upper - w.lower + 1e-12);
      }),
    );
    expect(wilson(5, 0)).toEqual({ p: 0, lower: 0, upper: 1 });
    expect(wilson(-3, 10).p).toBe(0);
    expect(wilson(30, 10).p).toBe(1);
  });

  it("property: Theil–Sen recovers an exact line and resists one outlier", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: 5, max: 40 }),
        (m, b, n) => {
          const xs = Array.from({ length: n }, (_, i) => i);
          const ys = xs.map((x) => m * x + b);
          ys[n - 1] = 1e9;
          const r = theilSen(xs, ys);
          expect(r.slope).toBeCloseTo(m, 6);
        },
      ),
    );
    expect(() => theilSen([1], [1, 2])).toThrow(RangeError);
    expect(theilSen([1], [7])).toMatchObject({ intercept: 7, n: 1 });
    expect(theilSen([], []).intercept).toBeNaN();
    const big = Array.from({ length: 5000 }, (_, i) => i);
    expect(
      theilSen(
        big,
        big.map((x) => 2 * x),
        { maxPoints: 100 },
      ).slope,
    ).toBeCloseTo(2, 6);
  });

  it("kneedle: finds the knee of a hockey stick, none for short/flat input, validates lengths", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const ys = xs.map((x) => (x < 12 ? x : x + (x - 12) ** 2 * 5));
    const r = kneedle(xs, ys);
    expect(r.knee).not.toBeNull();
    expect(r.knee?.x).toBeGreaterThanOrEqual(8);
    expect(kneedle([1, 2], [1, 2]).knee).toBeNull();
    expect(
      kneedle(
        xs,
        xs.map(() => 3),
      ).knee,
    ).toBeNull();
    expect(() => kneedle([1, 2, 3], [1, 2])).toThrow(RangeError);
    const dec = kneedle(
      xs,
      ys.map((y) => -y),
      { direction: "decreasing", curve: "concave" },
    );
    expect(dec.difference).toHaveLength(20);
  });
});
