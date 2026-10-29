/**
 * Capacity analysis over per-stage results (pure functions).
 * See docs/03-engines/stress-capacity-lab.md §3 (algorithms) and §6 (honesty rules),
 * docs/04-data-structures-and-algorithms.md §6.1 (Kneedle), §6.3 (CUSUM), §6.4 (Theil–Sen), §6.5 (USL).
 */
import { cusum } from "../../shared/stats/anomaly.js";
import { kneedle } from "../../shared/stats/knee.js";
import { median, normalQuantile } from "../../shared/stats/quantile.js";
import { theilSen } from "../../shared/stats/regression.js";
import type { StageResult, StageSeriesPoint, StressData } from "./types.js";
import { fitUsl } from "./usl.js";

const unitOf = (lt: "vus" | "rate"): string => (lt === "vus" ? "VUs" : "rps");

/** Marks stages at/after the first generator-saturated stage as invalid. Returns that index or null. */
export function applySaturationInvalidation(stages: StageResult[]): number | null {
  let from: number | null = null;
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i] as StageResult;
    if (from === null && s.generator.saturated) from = i;
    s.invalid = from !== null;
  }
  return from;
}

const usable = (s: StageResult): boolean => !s.invalid && (s.status === "passed" || s.status === "breached");

/**
 * Highest compliant stage, conservatively: the highest passing level strictly below the lowest
 * breaching level (a pass above a fail is treated as noise, not capacity).
 */
export function testedCapacity(
  stages: readonly StageResult[],
  loadType: "vus" | "rate",
  capLabel = "the safety rate cap",
): StressData["capacity"] {
  const valid = stages.filter(usable);
  const lowestFail = Math.min(
    Number.POSITIVE_INFINITY,
    ...valid.filter((s) => s.status === "breached").map((s) => s.level),
  );
  let best: StageResult | null = null;
  for (const s of valid) {
    if (s.status !== "passed" || s.level >= lowestFail) continue;
    if (!best || s.level > best.level) best = s;
  }
  if (!best) {
    return {
      testedCapacity: null,
      stageIndex: null,
      statement:
        valid.length === 0
          ? "No valid stage completed; no capacity statement is possible."
          : "No tested load met all requirements in this environment.",
    };
  }
  return {
    testedCapacity: best.level,
    stageIndex: best.index,
    statement: best.capped
      ? `Highest tested load that met all requirements in this environment: ${best.level} ${unitOf(loadType)} (${best.throughput.toFixed(1)} rps, limited by ${capLabel}; the target's capacity was not reached). This is not a capacity of the target.`
      : `Highest tested load that met all requirements in this environment: ${best.level} ${unitOf(loadType)} (${best.throughput.toFixed(1)} rps achieved). This is not a maximum capacity.`,
    ...(best.capped ? { limitedBySafetyCap: true } : {}),
  };
}

/** Lowest-level valid stage that breached, with the first failing threshold (or stop reason). */
export function firstBreach(stages: readonly StageResult[]): StressData["firstBreach"] {
  let first: StageResult | null = null;
  for (const s of stages) {
    if (!usable(s) || s.status !== "breached") continue;
    if (!first || s.level < first.level) first = s;
  }
  if (!first) return null;
  const t = first.thresholds.find((x) => !x.passed);
  if (t) {
    return {
      stageIndex: first.index,
      level: first.level,
      metric: t.metric,
      expression: t.expression,
      actual: t.actual,
      threshold: t.threshold,
    };
  }
  const reason = first.breachReasons[0] ?? "stop condition";
  return {
    stageIndex: first.index,
    level: first.level,
    metric: reason.startsWith("error-rate") ? "http.error_rate" : reason,
    expression: reason,
    actual: reason.startsWith("error-rate") ? first.errorRate : null,
    threshold: null,
  };
}

/** Valid stages, ascending by level (last result wins for duplicate levels). */
export function sortedValid(stages: readonly StageResult[]): StageResult[] {
  const byLevel = new Map<number, StageResult>();
  for (const s of stages) if (usable(s) && s.requests > 0) byLevel.set(s.level, s);
  return [...byLevel.values()].sort((a, b) => a.level - b.level);
}

/** Kneedle on (level, p95) of valid stages (convex, increasing). Needs ≥ 3 stages. */
export function findKnee(stages: readonly StageResult[]): StressData["knee"] {
  const v = sortedValid(stages);
  if (v.length < 3) return null;
  const r = kneedle(
    v.map((s) => s.level),
    v.map((s) => s.latency.p95),
    { curve: "convex", direction: "increasing" },
  );
  if (!r.knee) return null;
  const s = v[r.knee.index] as StageResult;
  return { stageIndex: s.index, level: s.level, p95: s.latency.p95, strength: r.knee.strength };
}

export function buildCurves(stages: readonly StageResult[]): StressData["curves"] {
  const v = sortedValid(stages);
  return {
    level: v.map((s) => s.level),
    throughput: v.map((s) => s.throughput),
    p95: v.map((s) => s.latency.p95),
    p99: v.map((s) => s.latency.p99),
    errorRate: v.map((s) => s.errorRate),
  };
}

export function uslFor(stages: readonly StageResult[], loadType: "vus" | "rate"): StressData["usl"] {
  const v = sortedValid(stages);
  const basis = loadType === "vus" ? "vus" : "mean-in-flight";
  return fitUsl(
    v.map((s) => ({ n: loadType === "vus" ? s.level : s.meanInFlight, x: s.throughput })),
    basis,
  );
}

const windowsWithData = (series: readonly StageSeriesPoint[]): StageSeriesPoint[] =>
  series.filter((p) => p.requests > 0);

/**
 * Spike recovery (§3.7): time from spike end until the per-window p95 is back within `tolerance`
 * (default 10 %, at least `floorMs`) of the pre-spike baseline for 3 consecutive windows.
 * Baseline = median of the pre-spike stage's window p95 (same statistic as the compared windows).
 * `gapS` = seconds between spike end and the start of the recovery stage's measured window.
 */
export function spikeRecovery(
  before: StageResult | undefined,
  peak: StageResult | undefined,
  after: StageResult | undefined,
  opts: { tolerance?: number; floorMs?: number; consecutive?: number } = {},
): NonNullable<StressData["spike"]> {
  const tol = opts.tolerance ?? 0.1;
  const floorMs = opts.floorMs ?? 1;
  const k = opts.consecutive ?? 3;
  const bw = before ? windowsWithData(before.series) : [];
  const baseline = bw.length > 0 ? median(bw.map((p) => p.p95)) : before ? before.latency.p95 : Number.NaN;
  const toleranceMs = Number.isFinite(baseline) ? Math.max(baseline * tol, floorMs) : Number.NaN;
  const out: NonNullable<StressData["spike"]> = {
    baselineP95: Number.isFinite(baseline) ? baseline : null,
    peakP95: peak ? peak.latency.p95 : null,
    recoveryTimeS: null,
    recovered: false,
    toleranceMs: Number.isFinite(toleranceMs) ? toleranceMs : 0,
  };
  if (!after || !peak || !Number.isFinite(baseline)) return out;
  const spikeEnd = peak.startMs + peak.settleMs + peak.holdMs;
  const afterMeasureStart = after.startMs + after.settleMs;
  const gapS = Math.max(0, (afterMeasureStart - spikeEnd) / 1000);
  const w = windowsWithData(after.series);
  let run = 0;
  for (let i = 0; i < w.length; i++) {
    const p = w[i] as StageSeriesPoint;
    if (p.p95 <= baseline + toleranceMs) {
      run++;
      if (run >= k) {
        const startPoint = w[i - k + 1] as StageSeriesPoint;
        out.recovered = true;
        out.recoveryTimeS = Math.round((gapS + startPoint.t) * 1000) / 1000;
        break;
      }
    } else run = 0;
  }
  return out;
}

/**
 * Sen's slope confidence interval (Kendall rank method, Sen 1968): with N pairwise slopes sorted,
 * C = z·sqrt(n(n−1)(2n+5)/18), bounds at ranks (N−C)/2 and (N+C)/2 + 1. n ≤ maxPoints (downsampled).
 */
export function senSlopeCI(
  xs: readonly number[],
  ys: readonly number[],
  alpha = 0.05,
  maxPoints = 400,
): [number, number] | null {
  const N0 = xs.length;
  if (N0 < 3) return null;
  const stride = N0 > maxPoints ? N0 / maxPoints : 1;
  const m = Math.min(N0, maxPoints);
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < m; i++) {
    const j = Math.min(N0 - 1, Math.floor(i * stride));
    x.push(xs[j] as number);
    y.push(ys[j] as number);
  }
  const slopes: number[] = [];
  for (let i = 0; i < m; i++)
    for (let j = i + 1; j < m; j++) {
      const dx = (x[j] as number) - (x[i] as number);
      if (dx !== 0) slopes.push(((y[j] as number) - (y[i] as number)) / dx);
    }
  const N = slopes.length;
  if (N < 2) return null;
  slopes.sort((a, b) => a - b);
  const z = normalQuantile(1 - alpha / 2);
  const C = z * Math.sqrt((m * (m - 1) * (2 * m + 5)) / 18);
  const lo = Math.max(0, Math.min(N - 1, Math.floor((N - C) / 2)));
  const hi = Math.max(0, Math.min(N - 1, Math.ceil((N + C) / 2)));
  return [slopes[lo] as number, slopes[hi] as number];
}

/**
 * Soak drift (§3.6): aggregate 1 s windows into `windowMs` buckets (request-weighted mean of window p95),
 * Theil–Sen slope of p95 over time (ms per hour) with Sen's CI; drift = slope > 0 and CI excludes 0.
 * CUSUM change points on the bucket series.
 */
export function soakDrift(
  series: readonly StageSeriesPoint[],
  windowMs: number,
): NonNullable<StressData["soak"]> {
  const bucketS = Math.max(1, windowMs / 1000);
  const buckets = new Map<number, { w: number; s: number }>();
  for (const p of series) {
    if (p.requests <= 0) continue;
    const b = Math.floor(p.t / bucketS);
    const cur = buckets.get(b) ?? { w: 0, s: 0 };
    cur.w += p.requests;
    cur.s += p.requests * p.p95;
    buckets.set(b, cur);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const ts = keys.map((k) => k * bucketS);
  const ys = keys.map((k) => {
    const b = buckets.get(k) as { w: number; s: number };
    return b.s / b.w;
  });
  const out: NonNullable<StressData["soak"]> = {
    windowMs,
    points: ys.length,
    p95SlopeMsPerHour: null,
    ci95: null,
    drift: false,
    changePoints: [],
  };
  if (ys.length < 3) return out;
  const ts0 = theilSen(ts, ys);
  out.p95SlopeMsPerHour = ts0.slope * 3600;
  const ci = senSlopeCI(ts, ys);
  if (ci) out.ci95 = [ci[0] * 3600, ci[1] * 3600];
  out.drift = ts0.slope > 0 && ci !== null && ci[0] > 0;
  const warm = Math.max(3, Math.floor(ys.length / 4));
  const cs = cusum(ys, { warmup: warm });
  out.changePoints = cs.signals.map((s) => ({ t: ts[s.index] as number, direction: s.direction }));
  return out;
}
