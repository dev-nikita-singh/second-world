/**
 * Statistical comparison of baseline vs variant — docs/04-data-structures-and-algorithms.md §6.2,
 * docs/05-optimization.md §5.
 *
 * - bootstrapCI: BCa (default) or percentile bootstrap, seeded rng, Float64Array resampling.
 * - mannWhitneyU: average ranks for ties; exact distribution for small samples without ties
 *   (n ≤ 20 per arm), otherwise normal approximation with tie + continuity correction.
 * - cliffsDelta (+ magnitude), hodgesLehmann shift, holm adjusted p-values, madZ (re-exported),
 *   wilson (re-exported), compareSamples → verdict improved | regressed | no-significant-change | inconclusive.
 */
import { madOutliers } from "./anomaly.js";
import { median, normalCdf, normalQuantile, quantile, sortedCopy } from "./quantile.js";

export { mad, madOutliers, madZ } from "./anomaly.js";
export { wilson } from "./proportion.js";

export type Rand = () => number;
export type TwoSampleStat = (a: Float64Array, b: Float64Array) => number;

export interface BootstrapOptions {
  /** Resamples (default 10,000). */
  B?: number;
  /** 1 − confidence (default 0.05). */
  alpha?: number;
  /** Uniform [0,1) source (required for determinism). */
  rng: Rand;
  /** "bca" (default) or "percentile". BCa falls back to percentile when degenerate. */
  method?: "bca" | "percentile";
}

export interface BootstrapResult {
  estimate: number;
  lower: number;
  upper: number;
  alpha: number;
  B: number;
  method: "bca" | "percentile";
}

function resample(src: Float64Array, dst: Float64Array, rng: Rand): void {
  const n = src.length;
  for (let i = 0; i < n; i++) dst[i] = src[Math.floor(rng() * n)] as number;
}

/**
 * Bootstrap confidence interval for `stat(a, b)`. Each arm is resampled independently.
 * For a one-sample statistic pass `b = []` and ignore the second argument.
 */
export function bootstrapCI(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  stat: TwoSampleStat,
  opts: BootstrapOptions,
): BootstrapResult {
  const B = Math.max(1, Math.floor(opts.B ?? 10_000));
  const alpha = opts.alpha ?? 0.05;
  const A = Float64Array.from(a as ArrayLike<number>);
  const Bs = Float64Array.from(b as ArrayLike<number>);
  const estimate = stat(A, Bs);
  const ra = new Float64Array(A.length);
  const rb = new Float64Array(Bs.length);
  const boots = new Float64Array(B);
  for (let i = 0; i < B; i++) {
    resample(A, ra, opts.rng);
    resample(Bs, rb, opts.rng);
    boots[i] = stat(ra, rb);
  }
  boots.sort();
  const pct = (): BootstrapResult => ({
    estimate,
    lower: quantile(boots, alpha / 2),
    upper: quantile(boots, 1 - alpha / 2),
    alpha,
    B,
    method: "percentile",
  });
  if ((opts.method ?? "bca") === "percentile") return pct();

  // BCa: bias correction z0
  let below = 0;
  let equal = 0;
  for (let i = 0; i < B; i++) {
    const v = boots[i] as number;
    if (v < estimate) below++;
    else if (v === estimate) equal++;
  }
  const z0 = normalQuantile((below + equal / 2) / B);
  if (!Number.isFinite(z0)) return pct();
  // acceleration via jackknife over both arms
  const jack: number[] = [];
  const jackOne = (src: Float64Array, which: "a" | "b"): void => {
    if (src.length < 2) return;
    const tmp = new Float64Array(src.length - 1);
    for (let i = 0; i < src.length; i++) {
      for (let j = 0, k = 0; j < src.length; j++) if (j !== i) tmp[k++] = src[j] as number;
      jack.push(which === "a" ? stat(tmp, Bs) : stat(A, tmp));
    }
  };
  jackOne(A, "a");
  jackOne(Bs, "b");
  if (jack.length === 0) return pct();
  let jm = 0;
  for (const v of jack) jm += v;
  jm /= jack.length;
  let num = 0;
  let den = 0;
  for (const v of jack) {
    const d = jm - v;
    num += d * d * d;
    den += d * d;
  }
  const acc = den > 0 ? num / (6 * den ** 1.5) : 0;
  const adj = (q: number): number => {
    const zq = normalQuantile(q);
    return normalCdf(z0 + (z0 + zq) / (1 - acc * (z0 + zq)));
  };
  const lo = adj(alpha / 2);
  const hi = adj(1 - alpha / 2);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return pct();
  return { estimate, lower: quantile(boots, lo), upper: quantile(boots, hi), alpha, B, method: "bca" };
}

/** Difference of medians b − a (two-sample statistic helper). */
export const medianDiff: TwoSampleStat = (a, b) => median(b) - median(a);

/** Relative difference of medians (b − a)/|a|; falls back to absolute difference when median(a) = 0. */
export const relativeMedianDiff: TwoSampleStat = (a, b) => {
  const ma = median(a);
  const mb = median(b);
  return ma === 0 ? mb - ma : (mb - ma) / Math.abs(ma);
};

export type Alternative = "two-sided" | "less" | "greater";

export interface MannWhitneyResult {
  /** U statistic of sample a (number of pairs a > b, ties count ½). */
  u: number;
  uA: number;
  uB: number;
  z: number;
  p: number;
  method: "exact" | "normal";
}

/** Average ranks (1-based) of `values`; returns ranks and Σ(t³ − t) over tie groups. */
export function rankWithTies(values: ArrayLike<number>): { ranks: Float64Array; tieSum: number } {
  const n = values.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((i, j) => (values[i] as number) - (values[j] as number));
  const ranks = new Float64Array(n);
  let tieSum = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1] as number] === values[idx[i] as number]) j++;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[idx[k] as number] = r;
    const t = j - i + 1;
    if (t > 1) tieSum += t * t * t - t;
    i = j + 1;
  }
  return { ranks, tieSum };
}

/** Exact null distribution of U for sizes (m, n): counts[u], u = 0..m·n. Iterative DP. */
function exactUCounts(m: number, n: number): Float64Array {
  // f[i][j][u] for i ≤ m, j ≤ n built iteratively over i with rolling arrays on j.
  const maxU = m * n;
  // prev[j] = counts for (i-1, j); cur[j] = counts for (i, j)
  let prev: Float64Array[] = [];
  for (let j = 0; j <= n; j++) {
    const c = new Float64Array(maxU + 1);
    c[0] = 1; // i = 0: only u = 0
    prev.push(c);
  }
  for (let i = 1; i <= m; i++) {
    const cur: Float64Array[] = [];
    for (let j = 0; j <= n; j++) {
      const c = new Float64Array(maxU + 1);
      if (j === 0) c[0] = 1;
      else {
        const left = prev[j] as Float64Array; // (i-1, j): last element from a is largest → +j
        const down = cur[j - 1] as Float64Array; // (i, j-1)
        for (let u = 0; u <= maxU; u++) {
          c[u] = (down[u] as number) + (u >= j ? (left[u - j] as number) : 0);
        }
      }
      cur.push(c);
    }
    prev = cur;
  }
  return prev[n] as Float64Array;
}

export function mannWhitneyU(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  opts: { alternative?: Alternative; exact?: boolean | "auto"; continuity?: boolean } = {},
): MannWhitneyResult {
  const n1 = a.length;
  const n2 = b.length;
  const alt = opts.alternative ?? "two-sided";
  if (n1 === 0 || n2 === 0)
    return { u: Number.NaN, uA: Number.NaN, uB: Number.NaN, z: Number.NaN, p: Number.NaN, method: "normal" };
  const all = new Float64Array(n1 + n2);
  for (let i = 0; i < n1; i++) all[i] = a[i] as number;
  for (let i = 0; i < n2; i++) all[n1 + i] = b[i] as number;
  const { ranks, tieSum } = rankWithTies(all);
  let r1 = 0;
  for (let i = 0; i < n1; i++) r1 += ranks[i] as number;
  const uA = r1 - (n1 * (n1 + 1)) / 2;
  const uB = n1 * n2 - uA;
  const mu = (n1 * n2) / 2;
  const N = n1 + n2;
  const variance = ((n1 * n2) / 12) * (N + 1 - tieSum / (N * (N - 1)));
  const exactMode = opts.exact ?? "auto";
  const useExact = exactMode === true || (exactMode === "auto" && n1 <= 20 && n2 <= 20 && tieSum === 0);
  if (useExact) {
    const counts = exactUCounts(n1, n2);
    let total = 0;
    for (const c of counts) total += c;
    // U from a: number of (a > b) pairs. P(U ≤ u) and P(U ≥ u).
    const uInt = Math.round(uA);
    let le = 0;
    let ge = 0;
    for (let u = 0; u < counts.length; u++) {
      if (u <= uInt) le += counts[u] as number;
      if (u >= uInt) ge += counts[u] as number;
    }
    const pLe = le / total;
    const pGe = ge / total;
    let p: number;
    if (alt === "greater") p = pGe;
    else if (alt === "less") p = pLe;
    else p = Math.min(1, 2 * Math.min(pLe, pGe));
    const z = variance > 0 ? (uA - mu) / Math.sqrt(variance) : 0;
    return { u: uA, uA, uB, z, p, method: "exact" };
  }
  if (!(variance > 0)) return { u: uA, uA, uB, z: 0, p: 1, method: "normal" };
  const sd = Math.sqrt(variance);
  const cc = opts.continuity === false ? 0 : 0.5;
  let z: number;
  let p: number;
  if (alt === "greater") {
    z = (uA - mu - cc) / sd;
    p = 1 - normalCdf(z);
  } else if (alt === "less") {
    z = (uA - mu + cc) / sd;
    p = normalCdf(z);
  } else {
    const d = Math.abs(uA - mu);
    z = Math.max(0, d - cc) / sd;
    p = Math.min(1, 2 * (1 - normalCdf(z)));
    z = Math.sign(uA - mu) * z;
  }
  return { u: uA, uA, uB, z, p, method: "normal" };
}

export type EffectMagnitude = "negligible" | "small" | "medium" | "large";

export interface CliffsDeltaResult {
  /** P(a > b) − P(a < b), in [−1, 1]. */
  delta: number;
  magnitude: EffectMagnitude;
}

export function cliffsMagnitude(delta: number): EffectMagnitude {
  const d = Math.abs(delta);
  if (d < 0.147) return "negligible";
  if (d < 0.33) return "small";
  if (d < 0.474) return "medium";
  return "large";
}

function lowerBound(s: Float64Array, x: number): number {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((s[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(s: Float64Array, x: number): number {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((s[mid] as number) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Cliff's δ = (#(a > b) − #(a < b)) / (n₁·n₂). O((n₁ + n₂) log n₂). */
export function cliffsDelta(a: ArrayLike<number>, b: ArrayLike<number>): CliffsDeltaResult {
  if (a.length === 0 || b.length === 0) return { delta: 0, magnitude: "negligible" };
  const sb = sortedCopy(b);
  let gt = 0;
  let lt = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    gt += lowerBound(sb, x); // b < x
    lt += sb.length - upperBound(sb, x); // b > x
  }
  const delta = (gt - lt) / (a.length * b.length);
  return { delta, magnitude: cliffsMagnitude(delta) };
}

/** Hodges–Lehmann shift estimate: median of all pairwise differences (b_j − a_i). */
export function hodgesLehmann(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || b.length === 0) return Number.NaN;
  const d = new Float64Array(a.length * b.length);
  let k = 0;
  for (let j = 0; j < b.length; j++)
    for (let i = 0; i < a.length; i++) d[k++] = (b[j] as number) - (a[i] as number);
  return median(d);
}

/** Holm–Bonferroni adjusted p-values (same order as input). */
export function holm(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adj = new Array<number>(m);
  let running = 0;
  order.forEach((e, rank) => {
    const v = Math.min(1, (m - rank) * e.p);
    running = Math.max(running, v);
    adj[e.i] = running;
  });
  return adj;
}

export type Direction = "lower-is-better" | "higher-is-better";
export type Verdict = "improved" | "regressed" | "no-significant-change" | "inconclusive";

export interface CompareOptions {
  direction: Direction;
  rng: Rand;
  /** Significance level (default 0.05). */
  alpha?: number;
  /** Bootstrap resamples (default 10,000). */
  B?: number;
  /** Minimum runs per arm (default 5). */
  minRuns?: number;
  /** |relative change| below which a precise result is called "no-significant-change" (default 0.05). */
  equivalenceMargin?: number;
  /** Minimum |relative change| to call improved/regressed (default 0). */
  minEffect?: number;
  bootstrapMethod?: "bca" | "percentile";
}

export interface CompareResult {
  verdict: Verdict;
  /** Relative difference of medians (variant − baseline)/|baseline| (absolute if baseline median is 0). */
  relativeChange: number;
  /** Bootstrap CI of relativeChange. */
  ci: { lower: number; upper: number; level: number; method: "bca" | "percentile" };
  p: number;
  mannWhitney: MannWhitneyResult;
  cliffsDelta: CliffsDeltaResult;
  /** Hodges–Lehmann shift (variant − baseline) in metric units. */
  hodgesLehmann: number;
  medians: { baseline: number; variant: number };
  n: { baseline: number; variant: number };
  /** Indexes of runs with robust |z| > 3.5 (reported, never dropped). */
  outliers: { baseline: number[]; variant: number[] };
  reasons: string[];
}

/** Compare per-run summaries of a baseline and a variant (docs/04 §6.2). */
export function compareSamples(
  baseline: ArrayLike<number>,
  variant: ArrayLike<number>,
  opts: CompareOptions,
): CompareResult {
  const alpha = opts.alpha ?? 0.05;
  const minRuns = opts.minRuns ?? 5;
  const margin = opts.equivalenceMargin ?? 0.05;
  const minEffect = opts.minEffect ?? 0;
  const mw = mannWhitneyU(baseline, variant);
  const cd = cliffsDelta(variant, baseline);
  const hl = hodgesLehmann(baseline, variant);
  const boot =
    baseline.length > 0 && variant.length > 0
      ? bootstrapCI(baseline, variant, relativeMedianDiff, {
          B: opts.B ?? 10_000,
          alpha,
          rng: opts.rng,
          method: opts.bootstrapMethod ?? "bca",
        })
      : {
          estimate: Number.NaN,
          lower: Number.NaN,
          upper: Number.NaN,
          alpha,
          B: 0,
          method: "percentile" as const,
        };
  const reasons: string[] = [];
  const outliers = { baseline: madOutliers(baseline), variant: madOutliers(variant) };
  if (outliers.baseline.length + outliers.variant.length > 0) {
    reasons.push(
      `outlier runs flagged (MAD z > 3.5): baseline ${outliers.baseline.length}, variant ${outliers.variant.length}`,
    );
  }
  const rel = boot.estimate;
  let verdict: Verdict;
  if (baseline.length < minRuns || variant.length < minRuns) {
    verdict = "inconclusive";
    reasons.push(
      `under-powered: need at least ${minRuns} runs per arm (got ${baseline.length} vs ${variant.length})`,
    );
  } else {
    const ciExcludesZero = boot.lower > 0 || boot.upper < 0;
    const significant = mw.p < alpha && ciExcludesZero;
    if (significant && Math.abs(rel) >= minEffect) {
      const better = opts.direction === "lower-is-better" ? rel < 0 : rel > 0;
      verdict = better ? "improved" : "regressed";
      reasons.push(`p=${mw.p.toPrecision(3)} < ${alpha} and CI excludes 0`);
    } else if (boot.lower >= -margin && boot.upper <= margin) {
      verdict = "no-significant-change";
      reasons.push(`CI [${boot.lower.toPrecision(3)}, ${boot.upper.toPrecision(3)}] within ±${margin}`);
    } else {
      verdict = "inconclusive";
      if (significant) reasons.push(`significant but |change| < minEffect ${minEffect}`);
      else if (ciExcludesZero !== mw.p < alpha) reasons.push("Mann–Whitney and bootstrap CI disagree");
      else reasons.push(`not significant and CI wider than ±${margin}: more runs needed`);
    }
  }
  return {
    verdict,
    relativeChange: rel,
    ci: { lower: boot.lower, upper: boot.upper, level: 1 - alpha, method: boot.method },
    p: mw.p,
    mannWhitney: mw,
    cliffsDelta: cd,
    hodgesLehmann: hl,
    medians: { baseline: median(baseline), variant: median(variant) },
    n: { baseline: baseline.length, variant: variant.length },
    outliers,
    reasons,
  };
}
