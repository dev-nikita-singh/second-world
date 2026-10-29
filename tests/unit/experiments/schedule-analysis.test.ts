import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRng } from "../../../src/core/rng.js";
import {
  type ComparisonInput,
  compareArms,
  flagOutliers,
  hypothesisStatus,
  minimumDetectableEffect,
  parseMetric,
  requiredRepetitions,
} from "../../../src/engines/experiments/analysis.js";
import { dominates, paretoFront, rankPareto } from "../../../src/engines/experiments/pareto.js";
import { projectMm1, projectUsl } from "../../../src/engines/experiments/projection.js";
import { buildSchedule } from "../../../src/engines/experiments/schedule.js";
import { parseExperimentInput, parseImprovement } from "../../../src/engines/experiments/schema.js";

const rand = (seed: number) => {
  const r = createRng(seed);
  return () => r.next();
};

function normalish(seed: number, n: number, mean: number, sd: number): number[] {
  const r = createRng(seed);
  return Array.from({ length: n }, () => {
    let s = 0;
    for (let i = 0; i < 12; i++) s += r.next();
    return mean + (s - 6) * sd;
  });
}

const opts = { alpha: 0.05, B: 2000, equivalenceMargin: 0.05, rand: (k: string) => rand(7 + k.length) };

describe("buildSchedule", () => {
  it("interleaved: every arm once per block, positions balanced (AB BA …)", () => {
    const s = buildSchedule(["A", "B"], 6, "interleaved", rand(1));
    expect(s.map((x) => x.arm).join("")).toBe("ABBAABBAABBA");
    const firstA = s.filter((x) => x.arm === "A" && s.find((y) => y.block === x.block)?.arm === "A").length;
    expect(firstA).toBe(3);
    for (const arm of ["A", "B"])
      expect(s.filter((x) => x.arm === arm).map((x) => x.rep)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("interleaved with 3 arms is a cyclic Latin square", () => {
    const s = buildSchedule(["A", "B", "C"], 3, "interleaved", rand(1));
    expect(s.map((x) => x.arm).join("")).toBe("ABCBCACAB");
  });

  it("randomized blocks: reproducible for a seed, each block a permutation", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1e6 }),
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 1, max: 8 }),
        (seed, k, r) => {
          const arms = Array.from({ length: k }, (_, i) => `arm${i}`);
          const a = buildSchedule(arms, r, "randomized-blocks", rand(seed));
          const b = buildSchedule(arms, r, "randomized-blocks", rand(seed));
          expect(a).toEqual(b);
          expect(a).toHaveLength(k * r);
          for (let blk = 0; blk < r; blk++) {
            expect(new Set(a.filter((x) => x.block === blk).map((x) => x.arm)).size).toBe(k);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("sequential: AAAA BBBB", () => {
    expect(
      buildSchedule(["A", "B"], 3, "sequential", rand(1))
        .map((x) => x.arm)
        .join(""),
    ).toBe("AAABBB");
  });
});

describe("compareArms verdicts", () => {
  const p95 = parseMetric("p95")!;
  const rps = parseMetric("rps")!;

  it("detects a known 30% latency improvement (CI excludes 0)", () => {
    const base = normalish(1, 6, 100, 3);
    const variant = normalish(2, 6, 70, 3);
    const [c] = compareArms(
      [{ variant: "v", metric: p95, baseline: base, values: variant, success: { improvement: 0.15 } }],
      opts,
    );
    expect(c!.verdict).toBe("improved");
    expect(c!.ci.upper).toBeLessThan(0);
    expect(c!.relativeChange).toBeLessThan(-0.2);
    expect(c!.success?.status).toBe("met");
    expect(c!.hodgesLehmann).toBeLessThan(-20);
  });

  it("higher-is-better metric: lower rps is a regression", () => {
    const [c] = compareArms(
      [{ variant: "v", metric: rps, baseline: normalish(3, 6, 1000, 10), values: normalish(4, 6, 800, 10) }],
      opts,
    );
    expect(c!.verdict).toBe("regressed");
  });

  it("A/A on low-noise samples → no-significant-change", () => {
    const [c] = compareArms(
      [{ variant: "aa", metric: p95, baseline: normalish(5, 8, 50, 0.5), values: normalish(6, 8, 50, 0.5) }],
      opts,
    );
    expect(c!.verdict).toBe("no-significant-change");
    expect(c!.mde).toBeLessThan(0.05);
  });

  it("wide CI → inconclusive with recommended repetitions > n", () => {
    const [c] = compareArms(
      [{ variant: "v", metric: p95, baseline: normalish(7, 5, 100, 30), values: normalish(8, 5, 95, 30) }],
      opts,
    );
    expect(c!.verdict).toBe("inconclusive");
    expect(c!.recommendedRepetitions).toBeGreaterThan(5);
  });

  it("Holm across metrics × variants adjusts p-values upward", () => {
    const inputs: ComparisonInput[] = ["p50", "p95", "p99", "mean"].map((m) => ({
      variant: "v",
      metric: parseMetric(m)!,
      baseline: normalish(9, 5, 100, 2),
      values: normalish(10, 5, 80, 2),
    }));
    const cs = compareArms(inputs, opts);
    for (const c of cs) expect(c.pAdjusted).toBeGreaterThanOrEqual(c.p);
    expect(Math.max(...cs.map((c) => c.pAdjusted))).toBeGreaterThan(Math.max(...cs.map((c) => c.p)) - 1e-12);
  });

  it("notWorse criterion is not met on regression", () => {
    const [c] = compareArms(
      [
        {
          variant: "v",
          metric: parseMetric("error_rate")!,
          baseline: [0, 0, 0, 0, 0, 0],
          values: [0.2, 0.25, 0.22, 0.3, 0.21, 0.24],
          success: { notWorse: true },
        },
      ],
      opts,
    );
    expect(c!.verdict).toBe("regressed");
    expect(c!.success?.status).toBe("not-met");
    expect(hypothesisStatus([c!])).toBe("rejected");
  });

  it("outlier runs are flagged (MAD z > 3.5), never dropped", () => {
    const vals = [50, 51, 49, 50, 52, 50, 400];
    expect(flagOutliers(vals)).toEqual([6]);
    const [c] = compareArms(
      [{ variant: "v", metric: p95, baseline: vals, values: [50, 50, 51, 49, 50, 52, 50] }],
      opts,
    );
    expect(c!.n.baseline).toBe(7);
    expect(c!.outliers.baseline).toEqual([6]);
  });

  it("power helpers are consistent", () => {
    const n = requiredRepetitions(0.1, 0.05, 0.05);
    expect(minimumDetectableEffect(0.1, n, 0.05)).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(minimumDetectableEffect(0.1, n - 1, 0.05)).toBeGreaterThan(0.05 - 0.005);
  });

  it("parseMetric", () => {
    expect(parseMetric("http.p95")?.direction).toBe("lower-is-better");
    expect(parseMetric("throughput")?.stat).toBe("rps");
    expect(parseMetric("endpoint.GET /products/search.p95")).toMatchObject({
      scope: "endpoint",
      endpoint: "GET /products/search",
      stat: "p95",
    });
    expect(parseMetric("server.cpu")).toBeNull();
  });
});

describe("Pareto front", () => {
  it("matches a brute-force definition (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 3, maxLength: 3 }), {
          minLength: 1,
          maxLength: 12,
        }),
        (vs) => {
          const items = vs.map((values) => ({ values }));
          const front = paretoFront(items);
          const brute = vs
            .map((v, i) => ({ v, i }))
            .filter(
              ({ v, i }) =>
                !vs.some(
                  (w, j) =>
                    j !== i &&
                    w.every((x, k) => x >= (v[k] as number)) &&
                    w.some((x, k) => x > (v[k] as number)),
                ),
            )
            .map(({ i }) => i);
          expect(front).toEqual(brute);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("ranks the front first; ties broken by score then diff size", () => {
    const ranked = rankPareto([
      { name: "slow", values: [1, 1] },
      { name: "fastBig", values: [5, 2], score: 1, diffSize: 100 },
      { name: "fastSmall", values: [5, 2], score: 1, diffSize: 10 },
      { name: "tradeoff", values: [2, 5], score: 2 },
    ]);
    expect(ranked.map((r) => r.name)).toEqual(["tradeoff", "fastSmall", "fastBig", "slow"]);
    expect(
      ranked
        .filter((r) => r.layer === 1)
        .map((r) => r.name)
        .sort(),
    ).toEqual(["fastBig", "fastSmall", "tradeoff"]);
    expect(ranked.find((r) => r.name === "slow")?.dominatedBy.sort()).toEqual([
      "fastBig",
      "fastSmall",
      "tradeoff",
    ]);
    expect(dominates([1, 1], [1, 1])).toBe(false);
  });

  it("statistically tied candidates are ordered by observed change, not by name", () => {
    // Both inconclusive (values 0, same score and diff size): the observed change decides.
    const ranked = rankPareto([
      { name: "a-slower", values: [0], score: 0, diffSize: 5, observed: -1.7 },
      { name: "b-faster", values: [0], score: 0, diffSize: 5, observed: 0.88 },
    ]);
    expect(ranked.map((r) => r.name)).toEqual(["b-faster", "a-slower"]);
    expect(ranked.every((r) => r.layer === 1)).toBe(true);
  });
});

describe("schema & projections", () => {
  it("parses improvement expressions", () => {
    expect(parseImprovement(">= 15%")).toBeCloseTo(0.15);
    expect(parseImprovement("15%")).toBeCloseTo(0.15);
    expect(parseImprovement(0.2)).toBeCloseTo(0.2);
  });

  it("validates experiments", () => {
    const e = parseExperimentInput({
      name: "x",
      baseline: { start: "node app.js" },
      variants: [{ name: "v", env: { A: "1" } }],
      success: { p95: { improvement: ">= 15%" }, error_rate: { notWorse: true } },
    });
    expect(e.design).toMatchObject({ repetitions: 5, order: "interleaved", lifecycle: "per-run" });
    expect(e.success.p95?.improvement).toBeCloseTo(0.15);
    expect(() => parseExperimentInput({ name: "x", variants: [] })).toThrow(/variant/);
    expect(() =>
      parseExperimentInput({ name: "x", variants: [{ name: "v" }], success: { p50: { notWorse: true } } }),
    ).toThrow(/not in metrics/);
  });

  it("projections are labelled estimates", () => {
    const [p] = projectMm1("a", 100, 5, [150, 1000]).slice(0, 1);
    expect(p!.kind).toBe("estimate");
    expect(p!.meanMs).toBeGreaterThan(5);
    expect(projectMm1("a", 100, 5, [1000])[0]!.saturated).toBe(true);
    const pts = [1, 2, 4, 8, 16, 32].map((n) => ({
      n,
      x: (100 * n) / (1 + 0.05 * (n - 1) + 0.001 * n * (n - 1)),
    }));
    const [u] = projectUsl(pts, [64]);
    expect(u!.kind).toBe("estimate");
    expect(u!.extrapolated).toBe(true);
    expect(u!.throughput).toBeGreaterThan(0);
  });
});
