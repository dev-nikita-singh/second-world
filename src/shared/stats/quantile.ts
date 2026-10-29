/**
 * Quantile definitions — docs/04-data-structures-and-algorithms.md §4.3.
 * - "nearest-rank": smallest v with count(≤ v) ≥ ⌈q·n⌉ (what histograms report).
 * - "type7": Hyndman–Fan type 7, linear interpolation (R / NumPy default) for small raw samples.
 * Also numeric helpers shared by the stats modules (sorting, median, normal distribution).
 */

export type QuantileMethod = "type7" | "nearest-rank";

/** Quantile of an ascending-sorted array; q in [0, 1]. NaN for empty input. */
export function quantile(sorted: ArrayLike<number>, q: number, method: QuantileMethod = "type7"): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const qq = Math.min(1, Math.max(0, q));
  if (method === "nearest-rank") {
    const rank = Math.max(1, Math.ceil(qq * n));
    return sorted[rank - 1] as number;
  }
  const h = (n - 1) * qq;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (h - lo) * (b - a);
}

/** Ascending numeric copy as Float64Array (typed sort is numeric). */
export function sortedCopy(values: ArrayLike<number>): Float64Array {
  const out = Float64Array.from(values as ArrayLike<number>);
  out.sort();
  return out;
}

/** Median of unsorted values (type 7). NaN for empty input. */
export function median(values: ArrayLike<number>): number {
  return quantile(sortedCopy(values), 0.5, "type7");
}

export function mean(values: ArrayLike<number>): number {
  if (values.length === 0) return Number.NaN;
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i] as number;
  return s / values.length;
}

/** Standard normal CDF Φ(z). erfc approximation with fractional error < 1.2e-7. */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** Inverse standard normal CDF (Acklam's algorithm, relative error < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const [a0, a1, a2, a3, a4, a5] = a as [number, number, number, number, number, number];
  const [b0, b1, b2, b3, b4] = b as [number, number, number, number, number];
  const [c0, c1, c2, c3, c4, c5] = c as [number, number, number, number, number, number];
  const [d0, d1, d2, d3] = d as [number, number, number, number];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    );
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
    (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
  );
}
