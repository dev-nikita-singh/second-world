/**
 * Kneedle knee/elbow detection (Satopää et al. 2011) — docs/04-data-structures-and-algorithms.md §6.1.
 * 1. Normalise (x, y) to [0, 1]. 2. Difference curve against the diagonal, oriented so the knee
 * is a local maximum (convex-increasing latency-vs-load: d = x − y). 3. A local maximum of d is
 * confirmed as a knee when d later drops below d_max − S·mean(Δx) before the next local maximum.
 * x must be strictly increasing (sorted). O(n).
 */

export type KneeCurve = "concave" | "convex";
export type KneeDirection = "increasing" | "decreasing";

export interface KneedleOptions {
  /** Default "convex" (latency rises sharply after the knee). */
  curve?: KneeCurve;
  /** Default "increasing". */
  direction?: KneeDirection;
  /** Sensitivity S (default 1). */
  sensitivity?: number;
}

export interface Knee {
  index: number;
  x: number;
  y: number;
  /** Normalised difference value at the knee (0..1, larger = sharper). */
  strength: number;
}

export interface KneedleResult {
  /** First confirmed knee (null if none). */
  knee: Knee | null;
  /** All confirmed knees, in x order. */
  knees: Knee[];
  /** Difference curve. */
  difference: Float64Array;
}

export function kneedle(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  opts: KneedleOptions = {},
): KneedleResult {
  const n = xs.length;
  if (n !== ys.length) throw new RangeError("kneedle: xs and ys must have equal length");
  const diff = new Float64Array(n);
  if (n < 3) return { knee: null, knees: [], difference: diff };
  const curve = opts.curve ?? "convex";
  const direction = opts.direction ?? "increasing";
  const S = opts.sensitivity ?? 1;
  let xmin = Number.POSITIVE_INFINITY;
  let xmax = Number.NEGATIVE_INFINITY;
  let ymin = Number.POSITIVE_INFINITY;
  let ymax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const x = xs[i] as number;
    const y = ys[i] as number;
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  const xr = xmax - xmin;
  const yr = ymax - ymin;
  if (!(xr > 0) || !(yr > 0)) return { knee: null, knees: [], difference: diff };
  const xn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xn[i] = ((xs[i] as number) - xmin) / xr;
    const yn = ((ys[i] as number) - ymin) / yr;
    const x = xn[i] as number;
    if (curve === "concave" && direction === "increasing") diff[i] = yn - x;
    else if (curve === "convex" && direction === "increasing") diff[i] = x - yn;
    else if (curve === "convex" && direction === "decreasing") diff[i] = 1 - x - yn;
    else diff[i] = yn - (1 - x); // concave decreasing
  }
  let meanDx = 0;
  for (let i = 1; i < n; i++) meanDx += (xn[i] as number) - (xn[i - 1] as number);
  meanDx /= n - 1;

  const knees: Knee[] = [];
  let candidate = -1;
  let threshold = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < n; i++) {
    const prev = diff[i - 1] as number;
    const cur = diff[i] as number;
    const next = i + 1 < n ? (diff[i + 1] as number) : Number.NEGATIVE_INFINITY;
    if (cur >= prev && cur > next && i < n - 1) {
      // new local maximum
      candidate = i;
      threshold = cur - S * meanDx;
      continue;
    }
    if (candidate >= 0 && cur < threshold) {
      knees.push({
        index: candidate,
        x: xs[candidate] as number,
        y: ys[candidate] as number,
        strength: diff[candidate] as number,
      });
      candidate = -1;
      threshold = Number.NEGATIVE_INFINITY;
    }
  }
  return { knee: knees[0] ?? null, knees, difference: diff };
}
