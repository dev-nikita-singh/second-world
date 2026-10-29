/**
 * Theil–Sen robust linear regression — docs/04-data-structures-and-algorithms.md §6.4,
 * docs/05-optimization.md §5 (downsample to ≤ 2,000 points so O(n²) stays cheap).
 * slope = median of pairwise slopes (pairs with equal x skipped); intercept = median(y − slope·x).
 */
import { median } from "./quantile.js";

export interface TheilSenResult {
  slope: number;
  intercept: number;
  /** Points actually used (after downsampling). */
  n: number;
}

export function theilSen(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  opts: { maxPoints?: number } = {},
): TheilSenResult {
  if (xs.length !== ys.length) throw new RangeError("theilSen: xs and ys must have equal length");
  const maxPoints = Math.max(2, opts.maxPoints ?? 2000);
  const N = xs.length;
  const stride = N > maxPoints ? N / maxPoints : 1;
  const m = Math.min(N, maxPoints);
  const x = new Float64Array(m);
  const y = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const j = Math.min(N - 1, Math.floor(i * stride));
    x[i] = xs[j] as number;
    y[i] = ys[j] as number;
  }
  if (m < 2) return { slope: Number.NaN, intercept: m === 1 ? (y[0] as number) : Number.NaN, n: m };
  const slopes = new Float64Array((m * (m - 1)) / 2);
  let c = 0;
  for (let i = 0; i < m; i++) {
    const xi = x[i] as number;
    const yi = y[i] as number;
    for (let j = i + 1; j < m; j++) {
      const dx = (x[j] as number) - xi;
      if (dx !== 0) slopes[c++] = ((y[j] as number) - yi) / dx;
    }
  }
  if (c === 0) return { slope: Number.NaN, intercept: median(y), n: m };
  const slope = median(slopes.subarray(0, c));
  const resid = new Float64Array(m);
  for (let i = 0; i < m; i++) resid[i] = (y[i] as number) - slope * (x[i] as number);
  return { slope, intercept: median(resid), n: m };
}
