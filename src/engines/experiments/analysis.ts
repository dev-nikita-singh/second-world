/**
 * Deterministic statistical comparison of arms. docs/03-engines/experiments.md §A.4 and
 * docs/04-data-structures-and-algorithms.md §6.2:
 * unit of analysis = per-repetition summary; Hodges–Lehmann shift; BCa bootstrap CI (seeded) of the
 * relative change of medians; Mann–Whitney U; Cliff's δ; Holm–Bonferroni across metrics × variants;
 * verdict improved | regressed | no-significant-change | inconclusive (+ recommended repetitions);
 * minimum detectable effect from the observed (A/A) variance; outlier runs flagged (MAD z > 3.5), never dropped.
 */
import {
  compareSamples,
  type Direction,
  holm,
  madOutliers,
  type Verdict,
} from "../../shared/stats/compare.js";
import { median, normalQuantile } from "../../shared/stats/quantile.js";
import type { PerformanceData } from "../performance/types.js";
import type { SuccessCriterion } from "./schema.js";

export type { Direction, Verdict };

// ------------------------------------------------------------------------------------------------
// Metrics

const LATENCY_STATS = new Set(["min", "mean", "stdDev", "p50", "p75", "p90", "p95", "p99", "p999", "max"]);
const ALIASES: Record<string, string> = {
  "error-rate": "error_rate",
  errors: "error_rate",
  errorRate: "error_rate",
  throughput: "rps",
  "timeout-rate": "timeout_rate",
  median: "p50",
  avg: "mean",
};

export interface MetricDef {
  /** As written by the user. */
  name: string;
  /** "http" or "endpoint". */
  scope: "http" | "endpoint";
  endpoint?: string;
  stat: string;
  direction: Direction;
  unit: "ms" | "per_s" | "ratio";
}

/** Parses `p95`, `http.p95`, `rps`, `error_rate`, `endpoint.GET /x.p95`. Returns null for unsupported metrics. */
export function parseMetric(name: string): MetricDef | null {
  let scope: MetricDef["scope"] = "http";
  let endpoint: string | undefined;
  let stat = name.trim();
  if (stat.startsWith("http.")) stat = stat.slice(5);
  else if (stat.startsWith("endpoint.")) {
    const rest = stat.slice("endpoint.".length);
    const dot = rest.lastIndexOf(".");
    if (dot <= 0) return null;
    scope = "endpoint";
    endpoint = rest.slice(0, dot);
    stat = rest.slice(dot + 1);
  } else if (stat.includes(".")) return null;
  stat = ALIASES[stat] ?? stat;
  if (LATENCY_STATS.has(stat))
    return { name, scope, ...(endpoint ? { endpoint } : {}), stat, direction: "lower-is-better", unit: "ms" };
  if (stat === "rps" || stat === "ok_rps")
    return {
      name,
      scope,
      ...(endpoint ? { endpoint } : {}),
      stat,
      direction: "higher-is-better",
      unit: "per_s",
    };
  if (stat === "error_rate" || stat === "timeout_rate") {
    return {
      name,
      scope,
      ...(endpoint ? { endpoint } : {}),
      stat,
      direction: "lower-is-better",
      unit: "ratio",
    };
  }
  return null;
}

/** Reads one per-run summary value from a Performance Lab result (corrected latency, ms). */
export function extractMetric(data: PerformanceData, m: MetricDef): number | undefined {
  if (m.scope === "endpoint") {
    const ep = data.endpoints.find((e) => e.key === m.endpoint);
    if (!ep) return undefined;
    if (LATENCY_STATS.has(m.stat)) return (ep.latency.corrected as unknown as Record<string, number>)[m.stat];
    if (m.stat === "rps") return ep.rps;
    if (m.stat === "ok_rps")
      return data.window.measuredMs > 0 ? (ep.ok * 1000) / data.window.measuredMs : undefined;
    if (m.stat === "error_rate") return ep.errorRate;
    if (m.stat === "timeout_rate") return ep.requests > 0 ? ep.timeouts / ep.requests : 0;
    return undefined;
  }
  if (LATENCY_STATS.has(m.stat)) return (data.latency.corrected as unknown as Record<string, number>)[m.stat];
  switch (m.stat) {
    case "rps":
      return data.totals.rps;
    case "ok_rps":
      return data.totals.okRps;
    case "error_rate":
      return data.totals.errorRate;
    case "timeout_rate":
      return data.totals.timeoutRate;
    default:
      return undefined;
  }
}

// ------------------------------------------------------------------------------------------------
// Power / noise floor

const Z_POWER = 0.8416212335729143; // Φ⁻¹(0.8)
/** Asymptotic relative efficiency of Mann–Whitney vs t-test under normality. */
const MW_ARE = 0.955;

function sd(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let m = 0;
  for (const v of values) m += v;
  m /= n;
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / (n - 1));
}

/** Pooled relative standard deviation of two arms (relative to |baseline median|; absolute when it is 0). */
export function pooledRelativeSd(a: readonly number[], b: readonly number[]): number {
  const s = Math.sqrt((sd(a) ** 2 + sd(b) ** 2) / 2);
  const m = Math.abs(median(a));
  return m > 0 ? s / m : s;
}

/** Minimum detectable relative effect for n runs per arm (two-sided α, power 0.8). */
export function minimumDetectableEffect(relSd: number, n: number, alpha: number): number {
  if (n <= 0) return Number.POSITIVE_INFINITY;
  const z = normalQuantile(1 - alpha / 2) + Z_POWER;
  return (z * relSd * Math.sqrt(2 / n)) / Math.sqrt(MW_ARE);
}

/** Runs per arm needed to detect a relative effect `effect` (two-sided α, power 0.8), clamped to [2, 1000]. */
export function requiredRepetitions(relSd: number, effect: number, alpha: number): number {
  if (!(effect > 0)) return 1000;
  const z = normalQuantile(1 - alpha / 2) + Z_POWER;
  const n = Math.ceil((2 * z * z * relSd * relSd) / (effect * effect) / MW_ARE);
  return Math.min(1000, Math.max(2, Number.isFinite(n) ? n : 1000));
}

// ------------------------------------------------------------------------------------------------
// Comparisons

export interface ComparisonInput {
  variant: string;
  metric: MetricDef;
  baseline: number[];
  values: number[];
  success?: SuccessCriterion | undefined;
}

export interface SuccessEvaluation {
  criterion: string;
  status: "met" | "not-met" | "inconclusive";
  detail: string;
}

export interface MetricComparison {
  variant: string;
  metric: string;
  direction: Direction;
  unit: MetricDef["unit"];
  verdict: Verdict;
  /** (variant − baseline)/|baseline| of medians; negative = lower. */
  relativeChange: number;
  ci: { lower: number; upper: number; level: number; method: "bca" | "percentile" };
  p: number;
  /** Holm-adjusted p across all metrics × variants. */
  pAdjusted: number;
  /** Hodges–Lehmann shift (variant − baseline), metric units. */
  hodgesLehmann: number;
  cliffsDelta: { delta: number; magnitude: string };
  medians: { baseline: number; variant: number };
  n: { baseline: number; variant: number };
  /** Indexes (within each arm's values) of runs with MAD z > 3.5. Reported, never dropped. */
  outliers: { baseline: number[]; variant: number[] };
  /** Pooled relative SD of per-run values. */
  relativeSd: number;
  /** Minimum detectable relative effect at this n (α, power 0.8). */
  mde: number;
  /** For inconclusive verdicts: runs per arm needed (observed variance). */
  recommendedRepetitions?: number;
  success?: SuccessEvaluation;
  reasons: string[];
}

export interface CompareOptions {
  alpha: number;
  B: number;
  equivalenceMargin: number;
  /** Uniform [0,1) source factory: one independent stream per comparison (deterministic). */
  rand: (key: string) => () => number;
  /** Fewer runs than this can never give "no-significant-change" (default 5). */
  minRunsForEquivalence?: number;
}

function describeCriterion(c: SuccessCriterion): string {
  const parts: string[] = [];
  if (c.improvement !== undefined) parts.push(`improvement >= ${(c.improvement * 100).toFixed(1)}%`);
  if (c.notWorse) parts.push("not worse");
  return parts.join(", ");
}

/** Oriented improvement: positive = better in the metric's direction. */
export function orientedChange(rel: number, direction: Direction): number {
  return direction === "lower-is-better" ? -rel : rel;
}

function evaluateSuccess(c: MetricComparison, crit: SuccessCriterion): SuccessEvaluation {
  const criterion = describeCriterion(crit);
  const better = orientedChange(c.relativeChange, c.direction);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  if (crit.notWorse && c.verdict === "regressed") {
    return { criterion, status: "not-met", detail: `regressed by ${pct(Math.abs(c.relativeChange))}` };
  }
  if (crit.improvement !== undefined) {
    if (c.verdict === "improved") {
      return better >= crit.improvement
        ? { criterion, status: "met", detail: `improved by ${pct(better)} (≥ ${pct(crit.improvement)})` }
        : {
            criterion,
            status: "not-met",
            detail: `improved by ${pct(better)}, below the required ${pct(crit.improvement)}`,
          };
    }
    if (c.verdict === "inconclusive")
      return { criterion, status: "inconclusive", detail: "comparison inconclusive" };
    return { criterion, status: "not-met", detail: `verdict ${c.verdict}` };
  }
  if (crit.notWorse) {
    if (c.verdict === "inconclusive") {
      // An inconclusive result whose CI cannot exclude a regression beyond the margin stays inconclusive.
      return { criterion, status: "inconclusive", detail: "comparison inconclusive" };
    }
    return { criterion, status: "met", detail: `verdict ${c.verdict}` };
  }
  return { criterion, status: "met", detail: "no criterion" };
}

/** Compares every (variant, metric) pair; Holm-adjusts p-values across all of them; decides verdicts. */
export function compareArms(inputs: readonly ComparisonInput[], opts: CompareOptions): MetricComparison[] {
  const minEq = opts.minRunsForEquivalence ?? 5;
  const raw = inputs.map((inp) =>
    compareSamples(inp.baseline, inp.values, {
      direction: inp.metric.direction,
      rng: opts.rand(`${inp.variant}|${inp.metric.name}`),
      alpha: opts.alpha,
      B: opts.B,
      minRuns: 1,
      equivalenceMargin: opts.equivalenceMargin,
    }),
  );
  const pAdj = holm(raw.map((r) => (Number.isFinite(r.p) ? r.p : 1)));
  return inputs.map((inp, i) => {
    const r = raw[i] as (typeof raw)[number];
    const pa = pAdj[i] as number;
    const n = Math.min(inp.baseline.length, inp.values.length);
    const relSd = pooledRelativeSd(inp.baseline, inp.values);
    const mde = minimumDetectableEffect(relSd, n, opts.alpha);
    const reasons: string[] = [];
    const ciExcludesZero = r.ci.lower > 0 || r.ci.upper < 0;
    const significant = pa < opts.alpha && ciExcludesZero;
    let verdict: Verdict;
    let recommendedRepetitions: number | undefined;
    if (n === 0) {
      verdict = "inconclusive";
      reasons.push("no successful runs in one of the arms");
    } else if (significant) {
      const better = orientedChange(r.relativeChange, inp.metric.direction) > 0;
      verdict = better ? "improved" : "regressed";
      reasons.push(
        `Holm-adjusted p=${pa.toPrecision(3)} < ${opts.alpha} and ${Math.round(r.ci.level * 100)}% CI excludes 0`,
      );
    } else if (n >= minEq && r.ci.lower >= -opts.equivalenceMargin && r.ci.upper <= opts.equivalenceMargin) {
      verdict = "no-significant-change";
      reasons.push(
        `CI [${r.ci.lower.toPrecision(3)}, ${r.ci.upper.toPrecision(3)}] within ±${opts.equivalenceMargin}`,
      );
    } else {
      verdict = "inconclusive";
      if (n < minEq) reasons.push(`under-powered: ${n} runs per arm (need ≥ ${minEq})`);
      if (pa < opts.alpha !== ciExcludesZero) reasons.push("Mann–Whitney (Holm) and bootstrap CI disagree");
      else reasons.push(`not significant and CI wider than ±${opts.equivalenceMargin}`);
      const target =
        inp.success?.improvement ??
        Math.max(opts.equivalenceMargin, Math.abs(Number.isFinite(r.relativeChange) ? r.relativeChange : 0));
      recommendedRepetitions = Math.max(n + 1, requiredRepetitions(relSd, target, opts.alpha));
      reasons.push(
        `≈ ${recommendedRepetitions} runs per arm needed to resolve a ${(target * 100).toFixed(1)}% effect at the observed variance`,
      );
    }
    if (r.outliers.baseline.length + r.outliers.variant.length > 0) {
      reasons.push(
        `outlier runs flagged (MAD z > 3.5): baseline ${r.outliers.baseline.length}, variant ${r.outliers.variant.length}`,
      );
    }
    const c: MetricComparison = {
      variant: inp.variant,
      metric: inp.metric.name,
      direction: inp.metric.direction,
      unit: inp.metric.unit,
      verdict,
      relativeChange: r.relativeChange,
      ci: r.ci,
      p: r.p,
      pAdjusted: pa,
      hodgesLehmann: r.hodgesLehmann,
      cliffsDelta: { delta: r.cliffsDelta.delta, magnitude: r.cliffsDelta.magnitude },
      medians: r.medians,
      n: r.n,
      outliers: r.outliers,
      relativeSd: relSd,
      mde,
      ...(recommendedRepetitions !== undefined ? { recommendedRepetitions } : {}),
      reasons,
    };
    if (inp.success) c.success = evaluateSuccess(c, inp.success);
    return c;
  });
}

/** Per-arm outlier run indexes (MAD z > 3.5) for one metric. */
export function flagOutliers(values: readonly number[]): number[] {
  return madOutliers(values);
}

export type HypothesisStatus = "supported" | "rejected" | "inconclusive" | "untested";

/** Combines success evaluations of one variant: any not-met → rejected; any inconclusive → inconclusive. */
export function hypothesisStatus(comparisons: readonly MetricComparison[]): HypothesisStatus {
  const evals = comparisons.flatMap((c) => (c.success ? [c.success] : []));
  if (evals.length === 0) {
    if (comparisons.some((c) => c.verdict === "regressed")) return "rejected";
    if (comparisons.some((c) => c.verdict === "improved")) return "supported";
    return comparisons.every((c) => c.verdict === "no-significant-change") ? "untested" : "inconclusive";
  }
  if (evals.some((e) => e.status === "not-met")) return "rejected";
  if (evals.some((e) => e.status === "inconclusive")) return "inconclusive";
  return "supported";
}
