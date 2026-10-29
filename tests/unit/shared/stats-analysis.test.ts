import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cusum, mad, madOutliers, madZ } from "../../../src/shared/stats/anomaly.js";
import {
  bootstrapCI,
  cliffsDelta,
  cliffsMagnitude,
  compareSamples,
  hodgesLehmann,
  holm,
  mannWhitneyU,
  medianDiff,
  rankWithTies,
} from "../../../src/shared/stats/compare.js";
import { kneedle } from "../../../src/shared/stats/knee.js";
import { wilson } from "../../../src/shared/stats/proportion.js";
import {
  median,
  normalCdf,
  normalQuantile,
  quantile,
  sortedCopy,
} from "../../../src/shared/stats/quantile.js";
import { theilSen } from "../../../src/shared/stats/regression.js";
import { normal, seeded } from "./_rng.js";

describe("quantile", () => {
  it("type7 matches NumPy/R reference values", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(xs, 0.5)).toBeCloseTo(5.5, 12);
    expect(quantile(xs, 0.9)).toBeCloseTo(9.1, 12);
    expect(quantile(xs, 0.25)).toBeCloseTo(3.25, 12);
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(10);
    expect(quantile([], 0.5)).toBeNaN();
  });

  it("nearest-rank definition", () => {
    const xs = [15, 20, 35, 40, 50];
    expect(quantile(xs, 0.05, "nearest-rank")).toBe(15);
    expect(quantile(xs, 0.3, "nearest-rank")).toBe(20);
    expect(quantile(xs, 0.4, "nearest-rank")).toBe(20);
    expect(quantile(xs, 0.5, "nearest-rank")).toBe(35);
    expect(quantile(xs, 1, "nearest-rank")).toBe(50);
  });

  it("monotone in q and bounded by min/max for both methods", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 50 }),
        (xs) => {
          const s = sortedCopy(xs);
          for (const m of ["type7", "nearest-rank"] as const) {
            let prev = Number.NEGATIVE_INFINITY;
            for (let q = 0; q <= 1.0001; q += 0.05) {
              const v = quantile(s, q, m);
              expect(v).toBeGreaterThanOrEqual(prev);
              expect(v).toBeGreaterThanOrEqual(s[0] as number);
              expect(v).toBeLessThanOrEqual(s[s.length - 1] as number);
              prev = v;
            }
          }
        },
      ),
    );
  });

  it("normal CDF / quantile", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 7);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232306167813, 6);
    for (const p of [0.01, 0.1, 0.3, 0.5, 0.8, 0.99]) expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 6);
  });
});

describe("Mann–Whitney U", () => {
  // SciPy docs example (males vs females): U1 = 17, exact p = 0.1111, asymptotic p = 0.11134688653314041
  const males = [19, 22, 16, 29, 24];
  const females = [20, 11, 17, 12];

  it("exact p-value on a textbook example", () => {
    const r = mannWhitneyU(males, females);
    expect(r.u).toBe(17);
    expect(r.uB).toBe(3);
    expect(r.method).toBe("exact");
    expect(r.p).toBeCloseTo(0.1111111111111111, 10);
  });

  it("normal approximation with continuity correction matches SciPy", () => {
    const r = mannWhitneyU(males, females, { exact: false });
    expect(r.method).toBe("normal");
    expect(r.p).toBeCloseTo(0.11134688653314041, 5);
  });

  it("tie-corrected normal approximation (hand-computed)", () => {
    // a=[1,2,2,3,4], b=[2,3,3,5,6,7]: U = 0 + ½ + ½ + (1 + ½ + ½) + 3 = 6.
    // ties: three 2s, three 3s → Σ(t³−t) = 48; var = 30/12·(12 − 48/110) = 28.909;
    // z = (|6 − 15| − 0.5)/√28.909 = 1.58088 → p = 2(1 − Φ(z)) ≈ 0.11390
    const r = mannWhitneyU([1, 2, 2, 3, 4], [2, 3, 3, 5, 6, 7]);
    expect(r.method).toBe("normal");
    expect(r.u).toBe(6);
    expect(Math.abs(r.z)).toBeCloseTo(1.58088, 4);
    expect(r.p).toBeCloseTo(0.1139, 3);
  });

  it("one-sided alternatives and exact == normal for moderately large n", () => {
    const r = mannWhitneyU(males, females, { alternative: "greater" });
    expect(r.p).toBeCloseTo(0.0555555, 5);
    const rng = seeded(5);
    const a = Array.from({ length: 20 }, () => rng());
    const b = Array.from({ length: 20 }, () => rng() + 0.2);
    const ex = mannWhitneyU(a, b, { exact: true });
    const nm = mannWhitneyU(a, b, { exact: false });
    expect(Math.abs(ex.p - nm.p)).toBeLessThan(0.01);
  });

  it("uA + uB = n1·n2 and p in [0,1]; exact p equals brute-force permutation p", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { minLength: 2, maxLength: 9 }),
        fc.integer({ min: 1, max: 7 }),
        (vals, cut) => {
          const k = Math.min(cut, vals.length - 1);
          const a = vals.slice(0, k);
          const b = vals.slice(k);
          const r = mannWhitneyU(a, b);
          expect(r.uA + r.uB).toBe(a.length * b.length);
          expect(r.p).toBeGreaterThanOrEqual(0);
          expect(r.p).toBeLessThanOrEqual(1);
          // brute force: enumerate all splits of ranks
          const N = vals.length;
          const uOf = (mask: number): number => {
            const A: number[] = [];
            const B: number[] = [];
            for (let i = 0; i < N; i++) ((mask >> i) & 1 ? A : B).push(i);
            let u = 0;
            for (const x of A) for (const y of B) if (x > y) u++;
            return u;
          };
          const sorted = [...vals].sort((x, y) => x - y);
          const rankA = a.map((v) => sorted.indexOf(v));
          let obsMask = 0;
          for (const i of rankA) obsMask |= 1 << i;
          const obs = uOf(obsMask);
          expect(obs).toBe(r.uA);
          let le = 0;
          let ge = 0;
          let tot = 0;
          for (let m = 0; m < 1 << N; m++) {
            let c = 0;
            for (let x = m; x; x &= x - 1) c++;
            if (c !== a.length) continue;
            const u = uOf(m);
            tot++;
            if (u <= obs) le++;
            if (u >= obs) ge++;
          }
          expect(r.p).toBeCloseTo(Math.min(1, (2 * Math.min(le, ge)) / tot), 10);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("rankWithTies averages ranks", () => {
    const { ranks, tieSum } = rankWithTies([10, 20, 20, 30]);
    expect([...ranks]).toEqual([1, 2.5, 2.5, 4]);
    expect(tieSum).toBe(6);
  });
});

describe("effect sizes and corrections", () => {
  it("Cliff's delta matches the O(n·m) definition", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 1, maxLength: 30 }),
        fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 1, maxLength: 30 }),
        (a, b) => {
          let s = 0;
          for (const x of a) for (const y of b) s += Math.sign(x - y);
          expect(cliffsDelta(a, b).delta).toBeCloseTo(s / (a.length * b.length), 12);
        },
      ),
    );
    expect(cliffsDelta([1, 2, 3], [1, 2, 3]).magnitude).toBe("negligible");
    expect(cliffsDelta([10, 11, 12], [1, 2, 3])).toEqual({ delta: 1, magnitude: "large" });
    expect(cliffsDelta([0.2, 1, 2, 3], [1, 2, 3, 0]).delta).toBeCloseTo(1 / 16, 12);
    expect(cliffsMagnitude(0.146)).toBe("negligible");
    expect(cliffsMagnitude(-0.2)).toBe("small");
    expect(cliffsMagnitude(0.4)).toBe("medium");
    expect(cliffsMagnitude(0.474)).toBe("large");
  });

  it("Hodges–Lehmann recovers a pure shift", () => {
    const a = [1, 5, 9, 2, 7];
    expect(
      hodgesLehmann(
        a,
        a.map((x) => x + 3),
      ),
    ).toBe(3);
    expect(hodgesLehmann([], [1])).toBeNaN();
  });

  it("Holm adjusted p-values (textbook example)", () => {
    // p = [0.01, 0.04, 0.03, 0.005] → sorted 0.005,0.01,0.03,0.04 ×4,×3,×2,×1 → 0.02,0.03,0.06,0.06 (monotone)
    expect(holm([0.01, 0.04, 0.03, 0.005]).map((x) => Number(x.toFixed(10)))).toEqual([
      0.03, 0.06, 0.06, 0.02,
    ]);
    expect(holm([0.5, 0.9])).toEqual([1, 1]);
    expect(holm([])).toEqual([]);
  });

  it("Holm adjusted ≥ raw, ≤ 1, and order-preserving", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 20 }), (ps) => {
        const adj = holm(ps);
        ps.forEach((p, i) => {
          expect(adj[i] as number).toBeGreaterThanOrEqual(p);
          expect(adj[i] as number).toBeLessThanOrEqual(1);
          ps.forEach((q, j) => {
            if (p < q) expect(adj[i] as number).toBeLessThanOrEqual(adj[j] as number);
          });
        });
      }),
    );
  });

  it("MAD robust z flags outliers", () => {
    const xs = [10, 11, 10, 12, 11, 10, 50];
    expect(mad(xs)).toBe(1);
    const z = madZ(xs);
    expect(z[6] as number).toBeCloseTo((0.6745 * 39) / 1, 6);
    expect(madOutliers(xs)).toEqual([6]);
    expect(madZ([5, 5, 5, 5])).toEqual([0, 0, 0, 0]);
    // MAD = 0 but not constant → mean-AD fallback still flags the outlier
    expect(madOutliers([5, 5, 5, 5, 5, 100])).toEqual([5]);
  });

  it("Wilson interval reference values", () => {
    const w = wilson(0, 10);
    expect(w.lower).toBe(0);
    expect(w.upper).toBeCloseTo(0.2775, 4);
    const v = wilson(5, 10);
    expect(v.lower).toBeCloseTo(0.2366, 4);
    expect(v.upper).toBeCloseTo(0.7634, 4);
    expect(wilson(3, 0)).toEqual({ p: 0, lower: 0, upper: 1 });
  });
});

describe("bootstrap", () => {
  it("is deterministic for a fixed seed", () => {
    const a = [1, 2, 3, 4, 5, 6, 7];
    const b = [3, 4, 5, 6, 7, 8, 9];
    const r1 = bootstrapCI(a, b, medianDiff, { B: 2000, rng: seeded(1) });
    const r2 = bootstrapCI(a, b, medianDiff, { B: 2000, rng: seeded(1) });
    expect(r1).toEqual(r2);
    expect(r1.estimate).toBe(2);
    expect(r1.lower).toBeLessThanOrEqual(2);
    expect(r1.upper).toBeGreaterThanOrEqual(2);
  });

  for (const method of ["percentile", "bca"] as const) {
    it(`${method} CI covers the true median ≈95% (seeded, tolerant)`, () => {
      const rng = seeded(2024);
      const trials = 150;
      let covered = 0;
      const oneSample = (s: Float64Array) => median(s);
      for (let t = 0; t < trials; t++) {
        // lognormal-ish skewed data with true median e^0 = 1 → shift by 10 → median 11
        const xs = Array.from({ length: 40 }, () => 10 + Math.exp(normal(rng)));
        const r = bootstrapCI(xs, [], (a) => oneSample(a), { B: 600, rng, method });
        if (r.lower <= 11 && 11 <= r.upper) covered++;
      }
      const rate = covered / trials;
      expect(rate).toBeGreaterThan(0.86);
      expect(rate).toBeLessThanOrEqual(1);
    });
  }
});

describe("compareSamples", () => {
  const rng = seeded(99);
  const gen = (n: number, mu: number, sd: number) => Array.from({ length: n }, () => mu + sd * normal(rng));

  it("detects an improvement (lower latency) and a regression", () => {
    const base = gen(10, 100, 3);
    const fast = gen(10, 80, 3);
    const r = compareSamples(base, fast, { direction: "lower-is-better", rng: seeded(1), B: 2000 });
    expect(r.verdict).toBe("improved");
    expect(r.relativeChange).toBeLessThan(-0.1);
    expect(r.ci.upper).toBeLessThan(0);
    expect(r.cliffsDelta.magnitude).toBe("large");
    const r2 = compareSamples(base, fast, { direction: "higher-is-better", rng: seeded(1), B: 2000 });
    expect(r2.verdict).toBe("regressed");
  });

  it("no-significant-change when precise and tiny; inconclusive when under-powered or noisy", () => {
    const a = gen(30, 100, 0.5);
    const b = gen(30, 100, 0.5);
    expect(compareSamples(a, b, { direction: "lower-is-better", rng: seeded(2), B: 2000 }).verdict).toBe(
      "no-significant-change",
    );
    const small = compareSamples([100, 101, 99], [80, 81, 79], {
      direction: "lower-is-better",
      rng: seeded(3),
      B: 500,
    });
    expect(small.verdict).toBe("inconclusive");
    expect(small.reasons.join(" ")).toMatch(/under-powered/);
    const noisy = compareSamples(gen(5, 100, 40), gen(5, 100, 40), {
      direction: "lower-is-better",
      rng: seeded(4),
      B: 2000,
    });
    expect(noisy.verdict).toBe("inconclusive");
  });

  it("reports outlier runs without dropping them", () => {
    const r = compareSamples([100, 101, 99, 100, 500, 101], [100, 99, 101, 100, 100, 99], {
      direction: "lower-is-better",
      rng: seeded(5),
      B: 1000,
    });
    expect(r.outliers.baseline).toEqual([4]);
    expect(r.n.baseline).toBe(6);
  });
});

describe("CUSUM", () => {
  it("detects a sustained upward shift shortly after it starts", () => {
    const rng = seeded(11);
    const xs = [
      ...Array.from({ length: 100 }, () => 100 + normal(rng)),
      ...Array.from({ length: 50 }, () => 103 + normal(rng)),
    ];
    const r = cusum(xs, { warmup: 100 });
    const first = r.signals[0];
    expect(first?.direction).toBe("up");
    expect(first?.index).toBeGreaterThanOrEqual(100);
    expect(first?.index).toBeLessThan(110);
    expect(r.signals.filter((s) => s.index < 100)).toHaveLength(0);
  });

  it("detects a downward shift and stays quiet on stationary noise", () => {
    const rng = seeded(12);
    const stable = Array.from({ length: 300 }, () => 50 + normal(rng));
    expect(cusum(stable).signals.length).toBeLessThanOrEqual(1);
    const down = [...stable.slice(0, 100), ...Array.from({ length: 30 }, () => 46 + normal(rng))];
    const r = cusum(down, { warmup: 100 });
    expect(r.signals[0]?.direction).toBe("down");
    expect(r.sPos).toHaveLength(130);
  });
});

describe("Theil–Sen", () => {
  it("recovers slope/intercept despite 25% gross outliers", () => {
    const rng = seeded(21);
    const xs = Array.from({ length: 200 }, (_, i) => i);
    const ys = xs.map((x) => 3 + 0.5 * x + 0.1 * normal(rng));
    for (let i = 0; i < 50; i++) ys[i * 4] = 1000;
    const r = theilSen(xs, ys);
    expect(r.slope).toBeCloseTo(0.5, 1);
    expect(Math.abs(r.intercept - 3)).toBeLessThan(2);
  });

  it("exact line, downsampling, degenerate inputs", () => {
    const xs = Array.from({ length: 5000 }, (_, i) => i);
    const r = theilSen(
      xs,
      xs.map((x) => 2 * x - 7),
      { maxPoints: 300 },
    );
    expect(r.n).toBe(300);
    expect(r.slope).toBeCloseTo(2, 10);
    expect(r.intercept).toBeCloseTo(-7, 8);
    expect(theilSen([1, 1, 1], [1, 2, 3]).slope).toBeNaN();
    expect(() => theilSen([1], [1, 2])).toThrow(RangeError);
  });
});

describe("Kneedle", () => {
  it("finds the knee of a hockey-stick latency curve", () => {
    const xs = Array.from({ length: 21 }, (_, i) => i * 10); // 0..200 VUs
    const ys = xs.map((x) => (x <= 120 ? 20 + x * 0.05 : 26 + (x - 120) * 4));
    const r = kneedle(xs, ys);
    expect(r.knee?.x).toBe(120);
  });

  it("finds the knee of a concave increasing curve (throughput saturation)", () => {
    const xs = Array.from({ length: 21 }, (_, i) => i * 10);
    const ys = xs.map((x) => (x <= 80 ? x * 10 : 800 + (x - 80) * 0.5));
    const r = kneedle(xs, ys, { curve: "concave", direction: "increasing" });
    expect(r.knee?.x).toBe(80);
  });

  it("decreasing convex curve (Satopää example shape y = 1/x)", () => {
    const xs = Array.from({ length: 100 }, (_, i) => 0.1 + i * 0.1);
    const ys = xs.map((x) => 1 / x);
    const r = kneedle(xs, ys, { curve: "convex", direction: "decreasing" });
    expect(r.knee).not.toBeNull();
    expect(r.knee?.x as number).toBeGreaterThan(0.5);
    expect(r.knee?.x as number).toBeLessThan(2);
  });

  it("no knee on a straight line or tiny input", () => {
    const xs = [0, 1, 2, 3, 4, 5];
    expect(kneedle(xs, xs).knee).toBeNull();
    expect(kneedle([1, 2], [1, 2]).knee).toBeNull();
    expect(kneedle([1, 2, 3], [5, 5, 5]).knee).toBeNull();
  });
});
