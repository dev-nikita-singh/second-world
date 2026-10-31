/**
 * Property + branch tests for What-If/Evolution statistics (src/engines/experiments/analysis.ts;
 * docs/03-engines/experiments.md §A.4, docs/04 §6). Owner: sw-coverage (Wave 5).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ComparisonInput,
  compareArms,
  extractMetric,
  flagOutliers,
  hypothesisStatus,
  type MetricComparison,
  minFeasibleRepetitions,
  minimumDetectableEffect,
  orientedChange,
  parseMetric,
  pooledRelativeSd,
  requiredRepetitions,
} from "../../../src/engines/experiments/analysis.js";

function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const opts = { alpha: 0.05, B: 400, equivalenceMargin: 0.05, rand: (k: string) => lcg(k.length * 7919 + 1) };
const p95 = parseMetric("p95")!;
const rps = parseMetric("http.rps")!;

describe("parseMetric", () => {
  it("scopes, aliases, directions and unsupported names", () => {
    expect(p95).toMatchObject({ scope: "http", stat: "p95", direction: "lower-is-better", unit: "ms" });
    expect(parseMetric("median")).toMatchObject({ stat: "p50" });
    expect(parseMetric("throughput")).toMatchObject({
      stat: "rps",
      direction: "higher-is-better",
      unit: "per_s",
    });
    expect(parseMetric("errorRate")).toMatchObject({ stat: "error_rate", unit: "ratio" });
    expect(parseMetric("endpoint.GET /a.b.p99")).toMatchObject({
      scope: "endpoint",
      endpoint: "GET /a.b",
      stat: "p99",
    });
    expect(parseMetric("endpoint.ok_rps")).toBeNull();
    expect(parseMetric("endpoint..p95")).toBeNull();
    expect(parseMetric("cpu.usage")).toBeNull();
    expect(parseMetric("bogus")).toBeNull();
  });

  it("extractMetric for http and endpoint scopes, missing endpoint and zero windows", () => {
    const data = {
      latency: { corrected: { p95: 12 } },
      totals: { rps: 100, okRps: 90, errorRate: 0.1, timeoutRate: 0.01 },
      window: { measuredMs: 0 },
      endpoints: [
        {
          key: "GET /a",
          latency: { corrected: { p95: 7 } },
          rps: 50,
          ok: 10,
          errorRate: 0.2,
          timeouts: 1,
          requests: 4,
        },
      ],
    } as never;
    expect(extractMetric(data, p95)).toBe(12);
    expect(extractMetric(data, rps)).toBe(100);
    expect(extractMetric(data, parseMetric("ok_rps")!)).toBe(90);
    expect(extractMetric(data, parseMetric("timeout_rate")!)).toBe(0.01);
    expect(extractMetric(data, parseMetric("endpoint.GET /a.p95")!)).toBe(7);
    expect(extractMetric(data, parseMetric("endpoint.GET /a.timeout_rate")!)).toBe(0.25);
    expect(extractMetric(data, parseMetric("endpoint.GET /a.ok_rps")!)).toBeUndefined();
    expect(extractMetric(data, parseMetric("endpoint.GET /a.error_rate")!)).toBe(0.2);
    expect(extractMetric(data, parseMetric("endpoint.GET /zz.p95")!)).toBeUndefined();
  });
});

describe("power analysis", () => {
  it("property: MDE decreases with n and requiredRepetitions achieves the requested effect", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 0.5, noNaN: true }),
        fc.double({ min: 0.02, max: 0.5, noNaN: true }),
        fc.integer({ min: 1, max: 200 }),
        (relSd, effect, n) => {
          expect(minimumDetectableEffect(relSd, n + 1, 0.05)).toBeLessThan(
            minimumDetectableEffect(relSd, n, 0.05),
          );
          const req = requiredRepetitions(relSd, effect, 0.05);
          expect(req).toBeGreaterThanOrEqual(2);
          expect(req).toBeLessThanOrEqual(1000);
          if (req < 1000 && req > 2) {
            expect(minimumDetectableEffect(relSd, req, 0.05)).toBeLessThanOrEqual(effect + 1e-9);
            expect(minimumDetectableEffect(relSd, req - 1, 0.05)).toBeGreaterThan(effect - 1e-9);
          }
        },
      ),
    );
    expect(minimumDetectableEffect(0.1, 0, 0.05)).toBe(Number.POSITIVE_INFINITY);
    expect(requiredRepetitions(0.1, 0, 0.05)).toBe(1000);
    expect(requiredRepetitions(Number.POSITIVE_INFINITY, 0.1, 0.05)).toBe(1000);
  });

  it("property: minFeasibleRepetitions is the first n where complete separation can reach α after Holm", () => {
    const central = (n: number) => {
      let c = 1;
      for (let k = 1; k <= n; k++) c = (c * (n + k)) / k;
      return c;
    };
    fc.assert(
      fc.property(fc.constantFrom(0.01, 0.05, 0.1), fc.integer({ min: 1, max: 20 }), (alpha, m) => {
        const n = minFeasibleRepetitions(alpha, m);
        expect((2 / central(n)) * m).toBeLessThan(alpha);
        if (n > 2) expect((2 / central(n - 1)) * m).toBeGreaterThanOrEqual(alpha);
      }),
    );
    expect(minFeasibleRepetitions(0.05, 4)).toBe(5);
    expect(minFeasibleRepetitions(0, 1)).toBe(1000);
  });

  it("pooledRelativeSd: relative to |median|, absolute when the median is 0; outliers flagged", () => {
    expect(pooledRelativeSd([10, 10, 10], [10, 10, 10])).toBe(0);
    expect(pooledRelativeSd([0, 0, 0], [1, 2, 3])).toBeCloseTo(Math.sqrt(0.5), 6);
    expect(pooledRelativeSd([5], [6])).toBe(0);
    expect(flagOutliers([10, 10, 11, 10, 9, 500])).toEqual([5]);
  });
});

describe("compareArms", () => {
  const base = [100, 101, 99, 100, 102, 98, 100, 101];
  const faster = base.map((x) => x * 0.7);
  const slower = base.map((x) => x * 1.3);

  it("clear improvement / regression; swapping arms flips the verdict", () => {
    const [imp, reg, rpsUp] = compareArms(
      [
        { variant: "fast", metric: p95, baseline: base, values: faster },
        { variant: "slow", metric: p95, baseline: base, values: slower },
        { variant: "fast", metric: rps, baseline: base, values: slower },
      ],
      opts,
    ) as MetricComparison[];
    expect(imp?.verdict).toBe("improved");
    expect(reg?.verdict).toBe("regressed");
    expect(rpsUp?.verdict).toBe("improved"); // higher-is-better
    const [swapped] = compareArms([{ variant: "x", metric: p95, baseline: faster, values: base }], opts);
    expect(swapped?.verdict).toBe("regressed");
    expect(imp?.reasons[0]).toMatch(/Holm-adjusted p=/);
  });

  it("identical arms → no-significant-change; tiny n → inconclusive with a recommendation; empty arm", () => {
    const [same] = compareArms([{ variant: "a", metric: p95, baseline: base, values: [...base] }], opts);
    expect(same?.verdict).toBe("no-significant-change");
    const [small] = compareArms(
      [{ variant: "a", metric: p95, baseline: [100, 101], values: [100, 102] }],
      opts,
    );
    expect(small?.verdict).toBe("inconclusive");
    expect(small?.recommendedRepetitions).toBeGreaterThanOrEqual(3);
    expect(small?.reasons.join(" ")).toMatch(/under-powered/);
    const [empty] = compareArms([{ variant: "a", metric: p95, baseline: [], values: [1, 2] }], opts);
    expect(empty?.verdict).toBe("inconclusive");
    expect(empty?.reasons[0]).toBe("no successful runs in one of the arms");
  });

  it("success criteria: met, below target, not-worse regressions, inconclusive", () => {
    const inputs: ComparisonInput[] = [
      { variant: "v", metric: p95, baseline: base, values: faster, success: { improvement: 0.2 } },
      { variant: "v", metric: p95, baseline: base, values: faster, success: { improvement: 0.5 } },
      { variant: "v", metric: p95, baseline: base, values: slower, success: { notWorse: true } },
      { variant: "v", metric: p95, baseline: base, values: [...base], success: { notWorse: true } },
      { variant: "v", metric: p95, baseline: [1, 2], values: [3, 4], success: { improvement: 0.1 } },
      { variant: "v", metric: p95, baseline: [1, 2], values: [3, 4], success: { notWorse: true } },
      { variant: "v", metric: p95, baseline: base, values: slower, success: { improvement: 0.1 } },
      { variant: "v", metric: p95, baseline: base, values: faster, success: {} },
    ];
    const r = compareArms(inputs, opts).map((c) => c.success?.status);
    expect(r).toEqual(["met", "not-met", "not-met", "met", "inconclusive", "inconclusive", "not-met", "met"]);
    expect(compareArms([inputs[0] as ComparisonInput], opts)[0]?.success?.criterion).toBe(
      "improvement >= 20.0%",
    );
  });

  it("outlier runs are reported in reasons, never dropped", () => {
    const withOutlier = [...base.slice(0, 7), 10_000];
    const [c] = compareArms([{ variant: "a", metric: p95, baseline: base, values: withOutlier }], opts);
    expect(c?.n.variant).toBe(8);
    expect(c?.reasons.join(" ")).toMatch(/outlier runs flagged/);
  });
});

describe("hypothesisStatus", () => {
  const c = (verdict: MetricComparison["verdict"], status?: "met" | "not-met" | "inconclusive") =>
    ({ verdict, ...(status ? { success: { criterion: "", status, detail: "" } } : {}) }) as MetricComparison;
  it("combines verdicts and success evaluations", () => {
    expect(hypothesisStatus([c("improved"), c("regressed")])).toBe("rejected");
    expect(hypothesisStatus([c("improved"), c("inconclusive")])).toBe("supported");
    expect(hypothesisStatus([c("no-significant-change")])).toBe("untested");
    expect(hypothesisStatus([c("inconclusive")])).toBe("inconclusive");
    expect(hypothesisStatus([])).toBe("untested");
    expect(hypothesisStatus([c("improved", "met"), c("improved", "not-met")])).toBe("rejected");
    expect(hypothesisStatus([c("improved", "met"), c("inconclusive", "inconclusive")])).toBe("inconclusive");
    expect(hypothesisStatus([c("improved", "met")])).toBe("supported");
    expect(orientedChange(0.1, "lower-is-better")).toBe(-0.1);
    expect(orientedChange(0.1, "higher-is-better")).toBe(0.1);
  });
});
