import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createFakeClock, systemClock } from "../../../src/core/clock.js";
import { createRng } from "../../../src/core/rng.js";

describe("systemClock", () => {
  it("is monotonic and sleeps", async () => {
    const a = systemClock.now();
    await systemClock.sleep(5);
    expect(systemClock.now() - a).toBeGreaterThanOrEqual(4);
    expect(systemClock.isoNow()).toMatch(/Z$/);
  });
  it("sleep rejects on abort", async () => {
    const ac = new AbortController();
    const p = systemClock.sleep(10_000, ac.signal);
    ac.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});

describe("createFakeClock", () => {
  it("advance resolves due sleepers in order", async () => {
    const c = createFakeClock(100);
    const order: number[] = [];
    const p1 = c.sleep(50).then(() => order.push(1));
    const p2 = c.sleep(10).then(() => order.push(2));
    expect(c.pending).toBe(2);
    c.advance(20);
    await p2;
    expect(order).toEqual([2]);
    c.advance(100);
    await p1;
    expect(order).toEqual([2, 1]);
    expect(c.now()).toBe(220);
    expect(c.isoNow()).toBe("2026-01-01T00:00:00.120Z");
  });
  it("abort removes sleeper; cannot go backwards", async () => {
    const c = createFakeClock();
    const ac = new AbortController();
    const p = c.sleep(10, ac.signal);
    ac.abort();
    await expect(p).rejects.toBeDefined();
    expect(c.pending).toBe(0);
    expect(() => c.set(-1)).toThrow(RangeError);
  });
});

describe("createRng (xoshiro128**)", () => {
  it("is deterministic for a seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const xs = Array.from({ length: 100 }, () => a.next());
    const ys = Array.from({ length: 100 }, () => b.next());
    expect(xs).toEqual(ys);
    expect(createRng(43).next()).not.toBe(xs[0]);
  });
  it("golden first values are pinned", () => {
    const r = createRng(1);
    const got = Array.from({ length: 4 }, () => r.nextU32());
    expect(got).toMatchInlineSnapshot(`
      [
        2442144158,
        3238099751,
        3819917871,
        2104621829,
      ]
    `);
  });
  it("property: next() in [0,1), int in range", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.nat(1000),
        (seed, lo, w) => {
          const r = createRng(seed);
          for (let i = 0; i < 20; i++) {
            const x = r.next();
            expect(x >= 0 && x < 1).toBe(true);
            const n = r.int(lo, lo + w);
            expect(n >= lo && n <= lo + w && Number.isInteger(n)).toBe(true);
          }
        },
      ),
    );
  });
  it("fork is deterministic, independent of parent draws, and distinct per name", () => {
    const p1 = createRng(7);
    const p2 = createRng(7);
    p2.next();
    p2.next();
    expect(p1.fork("vu-1").next()).toBe(p2.fork("vu-1").next());
    const a = createRng(7).fork("a");
    const b = createRng(7).fork("b");
    const n = 2000;
    const xa = Array.from({ length: n }, () => a.next());
    const xb = Array.from({ length: n }, () => b.next());
    expect(xa).not.toEqual(xb);
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    const ma = mean(xa);
    const mb = mean(xb);
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < n; i++) {
      const da = (xa[i] as number) - ma;
      const db = (xb[i] as number) - mb;
      cov += da * db;
      va += da * da;
      vb += db * db;
    }
    expect(Math.abs(cov / Math.sqrt(va * vb))).toBeLessThan(0.1);
  });
  it("property: forks with different names diverge", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.nat(), (x, y, seed) => {
        fc.pre(x !== y);
        const r = createRng(seed);
        const a = [r.fork(x).next(), r.fork(x).next()];
        const b = r.fork(y).next();
        expect(a[0]).toBe(a[1]);
        expect(b).not.toBe(a[0]);
      }),
    );
  });
  it("uniform distribution sanity (chi-square on 10 buckets)", () => {
    const r = createRng(123);
    const n = 100_000;
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < n; i++) {
      const k = Math.floor(r.next() * 10);
      buckets[k] = (buckets[k] as number) + 1;
    }
    const exp = n / 10;
    const chi = buckets.reduce((s, o) => s + (o - exp) ** 2 / exp, 0);
    expect(chi).toBeLessThan(27.88); // p=0.001, df=9
  });
  it("exponential(mean) has the right mean", () => {
    const r = createRng(99);
    let s = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) s += r.exponential(10);
    expect(s / n).toBeGreaterThan(9.7);
    expect(s / n).toBeLessThan(10.3);
    expect(() => r.exponential(0)).toThrow(RangeError);
  });
  it("pick and int errors", () => {
    const r = createRng(1);
    expect(["a", "b"]).toContain(r.pick(["a", "b"]));
    expect(() => r.pick([])).toThrow();
    expect(() => r.int(5, 1)).toThrow();
  });
  it("non-integer seeds are folded deterministically", () => {
    expect(createRng(1.5).next()).toBe(createRng(1.5).next());
    expect(createRng(-3).seed).toBe(createRng(-3).seed);
  });
});
