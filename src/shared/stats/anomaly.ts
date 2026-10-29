/**
 * Change-point detection (two-sided CUSUM) and robust z-scores (MAD) —
 * docs/04-data-structures-and-algorithms.md §6.3, §6.2 (outlier flagging, never silently dropped).
 * S⁺ = max(0, S⁺ + z − k), S⁻ = max(0, S⁻ − z − k); signal when either exceeds h (k = 0.5, h = 5).
 */
import { median, sortedCopy } from "./quantile.js";

const MAD_TO_SIGMA = 1.482602218505602; // 1 / Φ⁻¹(3/4)

/** Median absolute deviation (unscaled). */
export function mad(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  const m = median(values);
  const dev = new Float64Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs((values[i] as number) - m);
  return median(dev);
}

/**
 * Robust z-scores z = 0.6745·(x − median)/MAD. When MAD = 0, falls back to the mean absolute
 * deviation (z = (x − median)/(1.2533·meanAD)); if that is 0 too, all scores are 0.
 */
export function madZ(values: ArrayLike<number>): number[] {
  const n = values.length;
  if (n === 0) return [];
  const m = median(values);
  const d = mad(values);
  const out = new Array<number>(n);
  if (d > 0) {
    for (let i = 0; i < n; i++) out[i] = (0.6745 * ((values[i] as number) - m)) / d;
    return out;
  }
  let meanAd = 0;
  for (let i = 0; i < n; i++) meanAd += Math.abs((values[i] as number) - m);
  meanAd /= n;
  for (let i = 0; i < n; i++) out[i] = meanAd > 0 ? ((values[i] as number) - m) / (1.253314 * meanAd) : 0;
  return out;
}

/** Indexes with |robust z| > threshold (default 3.5). */
export function madOutliers(values: ArrayLike<number>, threshold = 3.5): number[] {
  const z = madZ(values);
  const out: number[] = [];
  for (let i = 0; i < z.length; i++) if (Math.abs(z[i] as number) > threshold) out.push(i);
  return out;
}

export interface CusumOptions {
  /** Allowance (slack) in σ units, default 0.5. */
  k?: number;
  /** Decision threshold in σ units, default 5. */
  h?: number;
  /** Reference mean; default: median of the first `warmup` points. */
  mean?: number;
  /** Reference σ; default: 1.4826·MAD of the first `warmup` points (falls back to std). */
  std?: number;
  /** Points used to estimate the reference (default: all). */
  warmup?: number;
  /** Reset both sums after a signal (default true). */
  resetOnSignal?: boolean;
}

export interface CusumSignal {
  index: number;
  direction: "up" | "down";
  /** Value of the statistic that crossed h. */
  statistic: number;
}

export interface CusumResult {
  signals: CusumSignal[];
  sPos: Float64Array;
  sNeg: Float64Array;
  mean: number;
  std: number;
}

/** Streaming two-sided CUSUM over already-standardised values z. */
export class Cusum {
  sPos = 0;
  sNeg = 0;
  constructor(
    readonly k = 0.5,
    readonly h = 5,
    private readonly resetOnSignal = true,
  ) {}

  update(z: number): "up" | "down" | null {
    this.sPos = Math.max(0, this.sPos + z - this.k);
    this.sNeg = Math.max(0, this.sNeg - z - this.k);
    let sig: "up" | "down" | null = null;
    if (this.sPos > this.h) sig = "up";
    else if (this.sNeg > this.h) sig = "down";
    if (sig && this.resetOnSignal) this.reset();
    return sig;
  }

  reset(): void {
    this.sPos = 0;
    this.sNeg = 0;
  }
}

export function cusum(values: ArrayLike<number>, opts: CusumOptions = {}): CusumResult {
  const n = values.length;
  const k = opts.k ?? 0.5;
  const h = opts.h ?? 5;
  const warm = Math.max(1, Math.min(n, opts.warmup ?? n));
  const ref = Array.from({ length: warm }, (_, i) => values[i] as number);
  const mu = opts.mean ?? (n > 0 ? median(ref) : 0);
  let sd = opts.std;
  if (sd === undefined) {
    sd = MAD_TO_SIGMA * (n > 0 ? mad(ref) : 0);
    if (!(sd > 0)) {
      // fall back to sample standard deviation
      const s = sortedCopy(ref);
      let m = 0;
      for (const x of s) m += x;
      m /= s.length || 1;
      let v = 0;
      for (const x of s) v += (x - m) ** 2;
      sd = s.length > 1 ? Math.sqrt(v / (s.length - 1)) : 0;
    }
  }
  const sPos = new Float64Array(n);
  const sNeg = new Float64Array(n);
  const signals: CusumSignal[] = [];
  const c = new Cusum(k, h, opts.resetOnSignal ?? true);
  for (let i = 0; i < n; i++) {
    const x = values[i] as number;
    const z = sd > 0 ? (x - mu) / sd : x === mu ? 0 : Math.sign(x - mu) * Number.MAX_VALUE;
    const before = { p: c.sPos, q: c.sNeg };
    const sig = c.update(z);
    if (sig) {
      const stat = sig === "up" ? Math.max(0, before.p + z - k) : Math.max(0, before.q - z - k);
      signals.push({ index: i, direction: sig, statistic: stat });
      sPos[i] = sig === "up" ? stat : c.sPos;
      sNeg[i] = sig === "down" ? stat : c.sNeg;
    } else {
      sPos[i] = c.sPos;
      sNeg[i] = c.sNeg;
    }
  }
  return { signals, sPos, sNeg, mean: mu, std: sd };
}
