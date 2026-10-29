/**
 * Sliding time windows + time-aware EWMA — docs/04-data-structures-and-algorithms.md §4.4,
 * docs/05-optimization.md §1 (bounded memory).
 *
 * WindowedSeries keeps fixed windows (default 1 s) in a ring of the last `maxWindows`
 * (default 3600 = 1 h). Each closed fine window is also folded into a coarse window
 * (`foldFactor` fine windows, default 60 → 1 min) kept in a second bounded ring, so a 24 h
 * soak uses the same memory as a 1 min test. Only the most recent `histogramWindows` fine
 * windows (and `histogramCoarseWindows` coarse windows) retain their HDR histogram; older
 * windows keep counters + a LatencySummary and their histogram is recycled (pooled) to
 * avoid GC churn. A whole-run `total` histogram is maintained separately.
 */
import { RingBuffer } from "../ds/ring-buffer.js";
import { LatencyHistogram, type LatencyHistogramOptions, type LatencySummary } from "./hdr.js";

export interface SeriesWindow {
  readonly startMs: number;
  readonly endMs: number;
  /** HDR histogram of latencies (µs). `null` once the window has been compacted. */
  histogram: LatencyHistogram | null;
  ok: number;
  failed: number;
  bytes: number;
  /** Set when the window closes (and kept after compaction). */
  summary: LatencySummary | null;
}

export interface WindowedSeriesOptions {
  /** Fine window length (default 1000 ms). */
  windowMs?: number;
  /** Fine windows kept (default 3600). */
  maxWindows?: number;
  /** Fine windows per coarse window (default 60). */
  foldFactor?: number;
  /** Coarse windows kept (default 1440 = 24 h of minutes). */
  maxCoarseWindows?: number;
  /** Most recent closed fine windows that keep a histogram (default 120). */
  histogramWindows?: number;
  /** Most recent coarse windows that keep a histogram (default 60). */
  histogramCoarseWindows?: number;
  /** Options for per-window histograms (default digits 2 = 1 % error, ~14 KB each). */
  histogram?: LatencyHistogramOptions;
  /** Options for the whole-run histogram (default digits 3). */
  totalHistogram?: LatencyHistogramOptions;
}

const EMPTY_SUMMARY: LatencySummary = Object.freeze({
  count: 0,
  min: 0,
  mean: 0,
  stdDev: 0,
  p50: 0,
  p75: 0,
  p90: 0,
  p95: 0,
  p99: 0,
  p999: 0,
  max: 0,
});

export class WindowedSeries {
  readonly windowMs: number;
  readonly foldFactor: number;
  private readonly histogramWindows: number;
  private readonly histogramCoarseWindows: number;
  private readonly histOpts: LatencyHistogramOptions;
  private readonly fine: RingBuffer<SeriesWindow>;
  private readonly coarseRing: RingBuffer<SeriesWindow>;
  private readonly maxWindows: number;
  private readonly maxCoarse: number;
  private readonly pool: LatencyHistogram[] = [];
  private cur: SeriesWindow | null = null;
  private coarseCur: SeriesWindow | null = null;
  /** Whole-run aggregate. */
  readonly total: LatencyHistogram;
  totalOk = 0;
  totalFailed = 0;
  totalBytes = 0;

  constructor(opts: WindowedSeriesOptions = {}) {
    this.windowMs = Math.max(1, opts.windowMs ?? 1000);
    this.maxWindows = Math.max(1, opts.maxWindows ?? 3600);
    this.foldFactor = Math.max(1, Math.floor(opts.foldFactor ?? 60));
    this.maxCoarse = Math.max(1, opts.maxCoarseWindows ?? 1440);
    this.histogramWindows = Math.max(0, opts.histogramWindows ?? 120);
    this.histogramCoarseWindows = Math.max(0, opts.histogramCoarseWindows ?? 60);
    this.histOpts = { digits: 2, ...opts.histogram };
    this.fine = new RingBuffer<SeriesWindow>(this.maxWindows, { grow: true });
    this.coarseRing = new RingBuffer<SeriesWindow>(this.maxCoarse, { grow: true });
    this.total = new LatencyHistogram({ digits: 3, ...opts.totalHistogram });
  }

  private alloc(): LatencyHistogram {
    const h = this.pool.pop();
    if (h) return h;
    return new LatencyHistogram(this.histOpts);
  }

  private recycle(w: SeriesWindow): void {
    if (w.histogram) {
      w.histogram.reset();
      if (this.pool.length < 8) this.pool.push(w.histogram);
      w.histogram = null;
    }
  }

  private open(startMs: number): SeriesWindow {
    return {
      startMs,
      endMs: startMs + this.windowMs,
      histogram: this.alloc(),
      ok: 0,
      failed: 0,
      bytes: 0,
      summary: null,
    };
  }

  /** The open window containing `nowMs` (closing earlier windows as needed). */
  current(nowMs: number): SeriesWindow {
    const cur = this.cur;
    if (cur === null) {
      this.cur = this.open(Math.floor(nowMs / this.windowMs) * this.windowMs);
      return this.cur;
    }
    if (nowMs < cur.endMs) return cur; // includes clock going backwards
    this.closeCurrent();
    // Fill gaps with empty windows (bounded by maxWindows).
    let start = cur.endMs;
    const target = Math.floor(nowMs / this.windowMs) * this.windowMs;
    const gaps = Math.round((target - start) / this.windowMs);
    if (gaps > this.maxWindows) start = target - this.maxWindows * this.windowMs;
    while (start < target) {
      this.pushClosed({
        startMs: start,
        endMs: start + this.windowMs,
        histogram: null,
        ok: 0,
        failed: 0,
        bytes: 0,
        summary: EMPTY_SUMMARY,
      });
      start += this.windowMs;
    }
    this.cur = this.open(target);
    return this.cur;
  }

  /** Convenience: record one outcome at `nowMs` into the current window and the total. */
  record(nowMs: number, latencyUs: number, ok: boolean, bytes = 0): void {
    const w = this.current(nowMs);
    w.histogram?.record(latencyUs);
    this.total.record(latencyUs);
    if (ok) {
      w.ok++;
      this.totalOk++;
    } else {
      w.failed++;
      this.totalFailed++;
    }
    w.bytes += bytes;
    this.totalBytes += bytes;
  }

  /** Close the current window if `nowMs` is past its end (call on ticks). */
  flush(nowMs: number): void {
    if (this.cur && nowMs >= this.cur.endMs) this.current(nowMs);
  }

  /** Force-close the current window (end of run). */
  closeAll(): void {
    this.closeCurrent();
    this.cur = null;
  }

  private closeCurrent(): void {
    const w = this.cur;
    if (!w) return;
    w.summary = w.histogram ? w.histogram.summary() : EMPTY_SUMMARY;
    this.pushClosed(w);
    this.cur = null;
  }

  private pushClosed(w: SeriesWindow): void {
    this.foldIntoCoarse(w);
    this.fine.push(w);
    if (this.fine.size > this.maxWindows) {
      const old = this.fine.shift();
      if (old) this.recycle(old);
    }
    // compact the window that just fell out of the histogram horizon
    const idx = this.fine.size - 1 - this.histogramWindows;
    if (idx >= 0) {
      const stale = this.fine.at(idx);
      if (stale) this.recycle(stale);
    }
  }

  private foldIntoCoarse(w: SeriesWindow): void {
    let c = this.coarseCur;
    if (c !== null && w.startMs >= c.endMs) {
      this.closeCoarse();
      c = null;
    }
    if (c === null) {
      const span = this.windowMs * this.foldFactor;
      const start = Math.floor(w.startMs / span) * span;
      c = {
        startMs: start,
        endMs: start + span,
        histogram: new LatencyHistogram(this.histOpts),
        ok: 0,
        failed: 0,
        bytes: 0,
        summary: null,
      };
      this.coarseCur = c;
    }
    if (w.histogram && c.histogram) c.histogram.add(w.histogram);
    c.ok += w.ok;
    c.failed += w.failed;
    c.bytes += w.bytes;
  }

  private closeCoarse(): void {
    const c = this.coarseCur;
    if (!c) return;
    c.summary = c.histogram ? c.histogram.summary() : EMPTY_SUMMARY;
    this.coarseRing.push(c);
    if (this.coarseRing.size > this.maxCoarse) this.coarseRing.shift();
    const idx = this.coarseRing.size - 1 - this.histogramCoarseWindows;
    if (idx >= 0) {
      const stale = this.coarseRing.at(idx);
      if (stale) stale.histogram = null;
    }
    this.coarseCur = null;
  }

  /** Closed fine windows, oldest first. */
  closed(): SeriesWindow[] {
    return this.fine.toArray();
  }

  /** Coarse (folded) windows, oldest first; includes the partially filled one. */
  coarse(): SeriesWindow[] {
    const out = this.coarseRing.toArray();
    if (this.coarseCur) out.push(this.coarseCur);
    return out;
  }

  /** The most recent closed fine window, if any. */
  lastClosed(): SeriesWindow | undefined {
    return this.fine.peekLast();
  }

  /**
   * Merge the histograms of the last `n` closed windows (plus the open one if `includeOpen`).
   * n is effectively capped by `histogramWindows`.
   */
  rolling(n: number, includeOpen = false): LatencyHistogram {
    const out = new LatencyHistogram(this.histOpts);
    const size = this.fine.size;
    for (let i = Math.max(0, size - n); i < size; i++) {
      const w = this.fine.at(i);
      if (w?.histogram) out.add(w.histogram);
    }
    if (includeOpen && this.cur?.histogram) out.add(this.cur.histogram);
    return out;
  }
}

/**
 * Time-aware exponentially weighted moving average: α = 1 − e^(−Δt/τ).
 * Irregular ticks are handled; the first sample initialises the value.
 */
export class Ewma {
  private s = 0;
  private last = Number.NaN;
  private init = false;

  constructor(readonly tauMs: number) {
    if (!(tauMs > 0)) throw new RangeError("Ewma tauMs must be > 0");
  }

  update(x: number, nowMs: number): number {
    if (!this.init) {
      this.s = x;
      this.init = true;
      this.last = nowMs;
      return this.s;
    }
    const dt = Math.max(0, nowMs - this.last);
    const alpha = 1 - Math.exp(-dt / this.tauMs);
    this.s += alpha * (x - this.s);
    if (nowMs > this.last) this.last = nowMs;
    return this.s;
  }

  get value(): number {
    return this.s;
  }

  get initialized(): boolean {
    return this.init;
  }

  reset(): void {
    this.s = 0;
    this.init = false;
    this.last = Number.NaN;
  }
}
