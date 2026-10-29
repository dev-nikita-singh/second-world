import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LatencyHistogram } from "../../../src/shared/stats/hdr.js";

function nearestRank(sorted: number[], q: number): number {
  const rank = Math.max(1, Math.ceil((q / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

const valuesArb = fc.array(fc.integer({ min: 1, max: 50_000_000 }), { minLength: 1, maxLength: 300 });

describe("LatencyHistogram", () => {
  it("empty histogram returns zeros", () => {
    const h = new LatencyHistogram();
    expect(h.summary()).toEqual({
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
  });

  it("basic percentiles on 1..1000", () => {
    const h = new LatencyHistogram();
    for (let i = 1; i <= 1000; i++) h.record(i);
    expect(h.count).toBe(1000);
    expect(h.percentile(50)).toBe(500);
    expect(h.percentile(99)).toBe(990);
    expect(h.min).toBe(1);
    expect(h.max).toBe(1000);
    expect(h.mean).toBeCloseTo(500.5, 1);
  });

  it("percentile within 0.1% relative error of exact nearest-rank", () => {
    fc.assert(
      fc.property(valuesArb, fc.double({ min: 0.1, max: 100, noNaN: true }), (values, q) => {
        const h = new LatencyHistogram();
        for (const v of values) h.record(v);
        const sorted = [...values].sort((a, b) => a - b);
        const exact = nearestRank(sorted, q);
        const got = h.percentile(q);
        expect(Math.abs(got - exact) / exact).toBeLessThanOrEqual(0.001 + 1e-12);
      }),
      { numRuns: 300 },
    );
  });

  it("percentile is monotone in q", () => {
    fc.assert(
      fc.property(valuesArb, (values) => {
        const h = new LatencyHistogram();
        for (const v of values) h.record(v);
        let prev = -1;
        for (let q = 0; q <= 100; q += 2.5) {
          const p = h.percentile(q);
          expect(p).toBeGreaterThanOrEqual(prev);
          prev = p;
        }
      }),
      { numRuns: 100 },
    );
  });

  it("merge(a, b) equals recording all values into one histogram", () => {
    fc.assert(
      fc.property(valuesArb, valuesArb, (a, b) => {
        const ha = new LatencyHistogram();
        const hb = new LatencyHistogram();
        const all = new LatencyHistogram();
        for (const v of a) {
          ha.record(v);
          all.record(v);
        }
        for (const v of b) {
          hb.record(v);
          all.record(v);
        }
        ha.add(hb);
        expect(ha.summary()).toEqual(all.summary());
      }),
      { numRuns: 100 },
    );
  });

  it("clamps out-of-range values instead of throwing", () => {
    const h = new LatencyHistogram({ highestUs: 1_000_000 });
    h.record(5_000_000);
    h.record(-3);
    h.record(Number.NaN);
    h.record(10);
    expect(h.count).toBe(4);
    expect(h.clamped).toBe(3);
    expect(h.max).toBeGreaterThanOrEqual(1_000_000);
    expect(h.max).toBeLessThanOrEqual(1_001_000);
    expect(h.min).toBe(0);
  });

  it("recordCorrected adds synthetic samples (coordinated omission)", () => {
    const h = new LatencyHistogram();
    h.recordCorrected(1000, 100);
    // 1000, 900, ..., 100 → 10 samples
    expect(h.count).toBe(10);
    expect(h.min).toBe(100);
    const raw = new LatencyHistogram();
    raw.recordCorrected(50, 100);
    expect(raw.count).toBe(1);
  });

  it("encode/decode round-trips and stays mergeable", () => {
    const h = new LatencyHistogram();
    for (let i = 1; i <= 5000; i += 7) h.record(i * 13);
    const s = h.encode();
    expect(typeof s).toBe("string");
    const d = LatencyHistogram.decode(s);
    // Exact max is not part of the encoding: after decode it is the bucket's highest equivalent value.
    const { max: dmax, ...drest } = d.summary();
    const { max: hmax, ...hrest } = h.summary();
    expect(drest).toEqual(hrest);
    expect(Math.abs(dmax - hmax) / hmax).toBeLessThanOrEqual(0.001);
    d.add(h);
    expect(d.count).toBe(h.count * 2);
  });

  it("reset and clone", () => {
    const h = new LatencyHistogram();
    h.record(42);
    const c = h.clone();
    h.reset();
    expect(h.count).toBe(0);
    expect(c.count).toBe(1);
    expect(c.percentile(50)).toBe(42);
  });

  it("add throws a RangeError when ranges are incompatible", () => {
    const small = new LatencyHistogram({ highestUs: 1000 });
    const big = new LatencyHistogram();
    big.record(1_000_000);
    expect(() => small.add(big)).toThrow(RangeError);
  });
});
