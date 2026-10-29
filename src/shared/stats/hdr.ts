/**
 * HDR latency histogram — docs/04-data-structures-and-algorithms.md §4.1, §3.5 (coordinated
 * omission correction), §4.3 (nearest-rank percentiles).
 *
 * Wraps hdr-histogram-js (pure-JS Int32 buckets, no WASM for portability). Values are integer
 * MICROSECONDS. Out-of-range values never throw: negatives/NaN are recorded as 0, values above
 * `highestUs` are recorded as `highestUs`, and both increment `clamped`.
 * Percentiles are nearest-rank over buckets (bounded relative error 10^-digits).
 */
import {
  build,
  decodeFromCompressedBase64,
  encodeIntoCompressedBase64,
  type Histogram,
} from "hdr-histogram-js";

export interface LatencySummary {
  count: number;
  min: number;
  mean: number;
  stdDev: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  p999: number;
  max: number;
}

export interface LatencyHistogramOptions {
  /** Lowest discernible value in µs (default 1). */
  lowestUs?: number;
  /** Highest trackable value in µs (default 1 h = 3.6e9 µs). */
  highestUs?: number;
  /** Significant decimal digits, 1..5 (default 3 = 0.1 % relative error). */
  digits?: 1 | 2 | 3 | 4 | 5;
}

const DEFAULT_HIGHEST = 3_600_000_000;

function makeHistogram(lowest: number, highest: number, digits: 1 | 2 | 3 | 4 | 5): Histogram {
  return build({
    bitBucketSize: 32,
    autoResize: false,
    lowestDiscernibleValue: lowest,
    highestTrackableValue: highest,
    numberOfSignificantValueDigits: digits,
    useWebAssembly: false,
  });
}

export class LatencyHistogram {
  private h: Histogram;
  readonly lowestUs: number;
  readonly highestUs: number;
  readonly digits: 1 | 2 | 3 | 4 | 5;
  /** Number of values that were out of range and clamped. */
  clamped = 0;

  constructor(opts: LatencyHistogramOptions = {}) {
    this.lowestUs = Math.max(1, Math.floor(opts.lowestUs ?? 1));
    this.highestUs = Math.max(this.lowestUs * 2, Math.floor(opts.highestUs ?? DEFAULT_HIGHEST));
    this.digits = opts.digits ?? 3;
    this.h = makeHistogram(this.lowestUs, this.highestUs, this.digits);
  }

  private clamp(us: number): number {
    if (!(us >= 0)) {
      // negative or NaN
      this.clamped++;
      return 0;
    }
    if (us > this.highestUs) {
      this.clamped++;
      return this.highestUs;
    }
    return Math.round(us);
  }

  /** Record one value in µs. O(1). */
  record(us: number): void {
    this.h.recordValue(this.clamp(us));
  }

  /** Record `count` occurrences of a value. */
  recordCount(us: number, count: number): void {
    if (count <= 0) return;
    this.h.recordValueWithCount(this.clamp(us), Math.floor(count));
  }

  /**
   * Record with coordinated-omission correction (§3.5): if `us > expectedIntervalUs`, also
   * records us − e, us − 2e, … down to e.
   */
  recordCorrected(us: number, expectedIntervalUs: number): void {
    const v = this.clamp(us);
    const e = Math.floor(expectedIntervalUs);
    if (e > 0) this.h.recordValueWithExpectedInterval(v, e);
    else this.h.recordValue(v);
  }

  /** Nearest-rank percentile, q in 0..100. Returns 0 when empty. */
  percentile(q: number): number {
    if (this.h.totalCount === 0) return 0;
    const qq = Math.min(100, Math.max(0, q));
    return this.h.getValueAtPercentile(qq);
  }

  get count(): number {
    return this.h.totalCount;
  }

  get min(): number {
    if (this.h.totalCount === 0) return 0;
    // minNonZeroValue ignores zeros; percentile(0) gives the true lowest bucket.
    return this.h.getValueAtPercentile(0);
  }

  get max(): number {
    return this.h.totalCount === 0 ? 0 : this.h.maxValue;
  }

  get mean(): number {
    return this.h.totalCount === 0 ? 0 : this.h.mean;
  }

  get stdDev(): number {
    return this.h.totalCount === 0 ? 0 : this.h.stdDeviation;
  }

  /** Approximate memory footprint in bytes. */
  get footprintBytes(): number {
    return this.h.estimatedFootprintInBytes;
  }

  /** Lossless merge (bucket-wise add). */
  add(other: LatencyHistogram): void {
    if (other.h.totalCount === 0) {
      this.clamped += other.clamped;
      return;
    }
    try {
      this.h.add(other.h);
    } catch (err) {
      throw new RangeError(
        `LatencyHistogram.add: other histogram exceeds this histogram's range (${String(err)})`,
      );
    }
    this.clamped += other.clamped;
  }

  reset(): void {
    this.h.reset();
    this.clamped = 0;
  }

  /** Deep copy. */
  clone(): LatencyHistogram {
    const c = new LatencyHistogram({
      lowestUs: this.lowestUs,
      highestUs: this.highestUs,
      digits: this.digits,
    });
    c.add(this);
    return c;
  }

  /** Compressed base64 (HdrHistogram V2 format) — re-mergeable later. */
  encode(): string {
    return encodeIntoCompressedBase64(this.h);
  }

  static decode(s: string): LatencyHistogram {
    const decoded = decodeFromCompressedBase64(s, 32, false);
    const out = new LatencyHistogram({
      highestUs: Math.max(DEFAULT_HIGHEST, decoded.highestTrackableValue),
      digits: clampDigits(decoded.numberOfSignificantValueDigits),
    });
    out.h.add(decoded);
    return out;
  }

  summary(): LatencySummary {
    return {
      count: this.count,
      min: this.min,
      mean: this.mean,
      stdDev: this.stdDev,
      p50: this.percentile(50),
      p75: this.percentile(75),
      p90: this.percentile(90),
      p95: this.percentile(95),
      p99: this.percentile(99),
      p999: this.percentile(99.9),
      max: this.max,
    };
  }
}

function clampDigits(d: number): 1 | 2 | 3 | 4 | 5 {
  const n = Math.min(5, Math.max(1, Math.round(d)));
  return n as 1 | 2 | 3 | 4 | 5;
}
