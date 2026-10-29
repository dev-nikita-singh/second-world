/**
 * Exact live percentiles for sharded runs — docs/03-engines/performance-lab.md §7 (workers).
 * Each worker sends the encoded HDR histogram of its newest closed 1 s window with its tick. Windows are
 * aligned on the shared t0, so window `startMs` is the same key in every worker. On each main-thread tick
 * the merger HDR-adds the newest window that every live worker has closed into one reused accumulator and
 * reports its p95/p99: the percentiles of the union, exactly as the in-process tick reports them for
 * its own last closed window. Bounded: `keep` windows per worker; a merge only happens when a newer
 * complete window exists (otherwise the cached result is returned).
 */
import { LatencyHistogram } from "../../shared/stats/hdr.js";

export interface MergedTickWindow {
  startMs: number;
  count: number;
  /** µs */
  p95: number;
  /** µs */
  p99: number;
}

export class TickWindowMerger {
  private readonly windows: Array<Map<number, string>>;
  private acc: LatencyHistogram | null = null;
  private last: MergedTickWindow | undefined;
  /** Number of merges performed (one per new complete window at most). */
  merges = 0;

  constructor(
    slots: number,
    private readonly keep = 4,
  ) {
    this.windows = Array.from({ length: slots }, () => new Map<number, string>());
  }

  /** Record worker `slot`'s closed window starting at `startMs` (encoded HDR histogram). */
  offer(slot: number, startMs: number, encoded: string): void {
    const m = this.windows[slot];
    if (!m) return;
    m.set(startMs, encoded);
    while (m.size > this.keep) {
      let oldest = Number.POSITIVE_INFINITY;
      for (const k of m.keys()) if (k < oldest) oldest = k;
      m.delete(oldest);
    }
  }

  retained(slot: number): number {
    return this.windows[slot]?.size ?? 0;
  }

  /**
   * Union percentiles of the newest window that every live slot (`live[i]`) has reported. Finished
   * slots never hold it back but still contribute the window if they have it. Undefined before any window.
   */
  merge(live: readonly boolean[]): MergedTickWindow | undefined {
    let target = Number.POSITIVE_INFINITY;
    let newestAny = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.windows.length; i++) {
      const m = this.windows[i] as Map<number, string>;
      let newest = Number.NEGATIVE_INFINITY;
      for (const k of m.keys()) if (k > newest) newest = k;
      if (newest > newestAny) newestAny = newest;
      if (live[i] === true && m.size > 0 && newest < target) target = newest;
    }
    if (target === Number.POSITIVE_INFINITY) target = newestAny;
    if (target === Number.NEGATIVE_INFINITY) return this.last;
    if (this.last && this.last.startMs >= target) return this.last;
    let acc = this.acc;
    acc?.reset();
    for (const m of this.windows) {
      const enc = m.get(target);
      if (enc === undefined) continue;
      const h = LatencyHistogram.decode(enc);
      if (acc === null || acc.digits !== h.digits || acc.highestUs < h.highestUs) {
        const prev = acc;
        acc = new LatencyHistogram({ highestUs: h.highestUs, digits: h.digits });
        if (prev) acc.add(prev);
      }
      acc.add(h);
    }
    this.acc = acc;
    this.merges++;
    this.last = acc
      ? { startMs: target, count: acc.count, p95: acc.percentile(95), p99: acc.percentile(99) }
      : { startMs: target, count: 0, p95: 0, p99: 0 };
    return this.last;
  }
}
