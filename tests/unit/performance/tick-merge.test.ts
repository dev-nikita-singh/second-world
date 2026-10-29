/**
 * Exact live perf.tick percentiles with workers > 1 (sw-fixes, wave 5): per-worker interval
 * histograms of the same 1 s window are HDR-added, so the tick p95/p99 are those of the union.
 */
import { describe, expect, it } from "vitest";
import { TickWindowMerger } from "../../../src/engines/performance/tick-merge.js";
import { LatencyHistogram } from "../../../src/shared/stats/hdr.js";

function windowHist(fastUs: number, fast: number, slowUs: number, slow: number): LatencyHistogram {
  const h = new LatencyHistogram({ digits: 2 });
  h.recordCount(fastUs, fast);
  h.recordCount(slowUs, slow);
  return h;
}

describe("TickWindowMerger", () => {
  it("p95/p99 equal the union's, not the max of the per-worker values", () => {
    // worker 0: 1000 fast; worker 1: 90 fast + 10 slow (its own p95 = slow).
    const a = windowHist(1000, 1000, 100_000, 0);
    const b = windowHist(1000, 90, 100_000, 10);
    const union = a.clone();
    union.add(b);
    const m = new TickWindowMerger(2);
    m.offer(0, 1000, a.encode());
    m.offer(1, 1000, b.encode());
    const r = m.merge([true, true]);
    expect(r?.count).toBe(1100);
    expect(r?.startMs).toBe(1000);
    expect(r?.p95).toBe(union.percentile(95));
    expect(r?.p99).toBe(union.percentile(99));
    // the old approximation (max of the parts) would report the slow value
    expect(Math.max(a.percentile(95), b.percentile(95))).toBeGreaterThanOrEqual(99_000);
    expect(r?.p95).toBeLessThan(2000);
  });

  it("merges the newest window every live worker has closed (workers tick out of phase)", () => {
    const m = new TickWindowMerger(2);
    m.offer(0, 0, windowHist(1000, 10, 0, 0).encode());
    m.offer(1, 0, windowHist(1000, 10, 0, 0).encode());
    m.offer(0, 1000, windowHist(2000, 5, 0, 0).encode());
    // worker 1 has not closed window 1000 yet → window 0 is the newest complete one
    expect(m.merge([true, true])).toMatchObject({ startMs: 0, count: 20 });
    m.offer(1, 1000, windowHist(2000, 7, 0, 0).encode());
    expect(m.merge([true, true])).toMatchObject({ startMs: 1000, count: 12 });
    // a finished worker does not hold the window back
    m.offer(0, 2000, windowHist(3000, 4, 0, 0).encode());
    expect(m.merge([true, false])).toMatchObject({ startMs: 2000, count: 4 });
  });

  it("merges at most once per new window (cached), and returns undefined before any window", () => {
    const m = new TickWindowMerger(2);
    expect(m.merge([true, true])).toBeUndefined();
    m.offer(0, 0, windowHist(1000, 3, 0, 0).encode());
    m.offer(1, 0, windowHist(1000, 3, 0, 0).encode());
    const first = m.merge([true, true]);
    expect(m.merge([true, true])).toEqual(first);
    expect(m.merges).toBe(1);
  });

  it("keeps a bounded number of windows per worker", () => {
    const m = new TickWindowMerger(1, 3);
    for (let w = 0; w < 50; w++) m.offer(0, w * 1000, windowHist(1000, 1, 0, 0).encode());
    expect(m.retained(0)).toBe(3);
    expect(m.merge([true])?.startMs).toBe(49_000);
  });
});
