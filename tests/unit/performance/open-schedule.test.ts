import { describe, expect, it } from "vitest";
import { createRng } from "../../../src/core/rng.js";
import type { Clock } from "../../../src/core/types.js";
import {
  arrivalOffsets,
  expectedArrivals,
  offsetForCount,
  runOpenSchedule,
} from "../../../src/engines/performance/scheduler/open.js";

/** Single-sleeper fake clock: sleep advances time instantly (enough for the open scheduler loop). */
function autoClock(start = 1000): Clock & { set(t: number): void } {
  let now = start;
  return {
    now: () => now,
    isoNow: () => new Date(now).toISOString(),
    sleep: async (ms) => {
      now += ms;
    },
    set: (t) => {
      now = t;
    },
  };
}

describe("open-loop schedule math", () => {
  it("constant rate: intended offsets are exactly i*1000/rate (no drift over 10k arrivals)", () => {
    const rate = 137;
    const offs = [
      ...arrivalOffsets({ rate, arrival: "constant", rampUpMs: 0, totalMs: (10_000 * 1000) / rate }),
    ];
    expect(offs).toHaveLength(10_000);
    for (let i = 0; i < offs.length; i++) expect(offs[i]).toBe((i * 1000) / rate);
  });

  it("ramp-up follows the integral of a linear rate ramp", () => {
    const rate = 100;
    const R = 2000;
    // ramp delivers rate*R/2 = 100 arrivals in 2 s, then 100/s
    expect(offsetForCount(0, rate, R)).toBe(0);
    expect(offsetForCount(100, rate, R)).toBeCloseTo(2000, 9);
    expect(offsetForCount(150, rate, R)).toBeCloseTo(2500, 9);
    expect(offsetForCount(25, rate, R)).toBeCloseTo(1000, 9); // N(1s) = r t^2 / 2R = 25
    const offs = [...arrivalOffsets({ rate, arrival: "constant", rampUpMs: R, totalMs: 4000 })];
    expect(offs.length).toBe(300);
    expect(expectedArrivals({ rate, rampUpMs: R }, 0, 4000)).toBeCloseTo(300, 9);
    expect(expectedArrivals({ rate, rampUpMs: R }, 1000, 2000)).toBeCloseTo(75, 9);
  });

  it("poisson: mean rate within 2% and exponential gaps (CV close to 1) with a fixed seed", () => {
    const rate = 200;
    const offs = [
      ...arrivalOffsets({ rate, arrival: "poisson", rampUpMs: 0, totalMs: 100_000, rng: createRng(42) }),
    ];
    const achieved = offs.length / 100;
    expect(Math.abs(achieved - rate) / rate).toBeLessThan(0.02);
    const gaps = offs.slice(1).map((t, i) => t - (offs[i] as number));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    expect(Math.abs(mean - 1000 / rate)).toBeLessThan(0.1);
    expect(sd / mean).toBeGreaterThan(0.95);
    expect(sd / mean).toBeLessThan(1.05);
    // reproducible
    const again = [
      ...arrivalOffsets({ rate, arrival: "poisson", rampUpMs: 0, totalMs: 1000, rng: createRng(42) }),
    ];
    expect(again).toEqual(offs.slice(0, again.length));
  });
});

describe("runOpenSchedule", () => {
  it("passes exact intended times (t0 + i*1000/rate) with a fake clock", async () => {
    const clock = autoClock();
    const seen: number[] = [];
    const r = await runOpenSchedule({
      rate: 50,
      arrival: "constant",
      rampUpMs: 0,
      totalMs: 10_000,
      clock,
      signal: new AbortController().signal,
      maxInFlight: 1000,
      spinMs: 0,
      onArrival: async (t) => {
        seen.push(t);
      },
    });
    expect(r.scheduled).toBe(500);
    expect(r.released).toBe(500);
    expect(seen).toHaveLength(500);
    for (let i = 0; i < seen.length; i++) expect(seen[i]).toBe(r.t0 + (i * 1000) / 50);
    expect(r.lag.max).toBe(0);
  });

  it("catch-up: a 1 s generator stall releases all due arrivals at once and records lag", async () => {
    const clock = autoClock(0);
    const seen: { intended: number; at: number }[] = [];
    let stalled = false;
    const r = await runOpenSchedule({
      rate: 100,
      arrival: "constant",
      rampUpMs: 0,
      totalMs: 2000,
      clock,
      signal: new AbortController().signal,
      maxInFlight: 10_000,
      spinMs: 0,
      t0: 0,
      onArrival: async (t) => {
        seen.push({ intended: t, at: clock.now() });
        if (!stalled && t >= 500) {
          stalled = true;
          clock.set(clock.now() + 1000); // event loop blocked for 1 s
        }
      },
    });
    expect(r.scheduled).toBe(200);
    // intended times are unaffected by the stall
    for (const [i, s] of seen.entries()) expect(s.intended).toBe(i * 10);
    expect(r.lag.max).toBeGreaterThanOrEqual(990_000);
    const burst = seen.filter((s) => s.at === 1500);
    expect(burst.length).toBeGreaterThanOrEqual(99);
  });

  it("drops arrivals beyond maxInFlight instead of delaying them", async () => {
    const clock = autoClock(0);
    const never = new Promise<void>(() => {});
    const dropped: number[] = [];
    const r = await runOpenSchedule({
      rate: 100,
      arrival: "constant",
      rampUpMs: 0,
      totalMs: 1000,
      clock,
      signal: new AbortController().signal,
      maxInFlight: 10,
      spinMs: 0,
      onArrival: () => never,
      onDrop: (t) => dropped.push(t),
    });
    expect(r.released).toBe(10);
    expect(r.dropped).toBe(90);
    expect(dropped).toHaveLength(90);
    expect(r.inFlight()).toBe(10);
  });

  it("stops scheduling when the signal aborts", async () => {
    const clock = autoClock(0);
    const ac = new AbortController();
    const r = await runOpenSchedule({
      rate: 100,
      arrival: "constant",
      rampUpMs: 0,
      totalMs: 10_000,
      clock,
      signal: ac.signal,
      maxInFlight: 100,
      spinMs: 0,
      onArrival: async (t) => {
        if (t >= 990) ac.abort();
      },
    });
    expect(r.scheduled).toBe(100);
  });
});
