/**
 * Wilson score interval for a binomial proportion — docs/04-data-structures-and-algorithms.md §6.6.
 * (p̂ + z²/2n ± z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n). Correct for small n and p near 0/1.
 */
export interface ProportionInterval {
  p: number;
  lower: number;
  upper: number;
}

export function wilson(k: number, n: number, z = 1.959963984540054): ProportionInterval {
  if (!(n > 0)) return { p: 0, lower: 0, upper: 1 };
  const kk = Math.min(Math.max(0, k), n);
  const p = kk / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    p,
    lower: Math.max(0, (center - margin) / denom),
    upper: Math.min(1, (center + margin) / denom),
  };
}
