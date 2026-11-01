/**
 * safety.maxRps is a world-wide cap shared by every lease (docs/11-safety-security-privacy.md §2
 * "hard budgets"); a lease asking for a lower rate is additionally paced by its own limiter.
 * Deterministic: fake clock, GCRA burst = ceil(rps / 10).
 */
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../src/core/clock.js";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";

/** Resolves true when `p` has settled after draining microtasks (no clock advance). */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return done;
}

describe("safety.maxRps is world-wide", () => {
  it("two leases share one burst: the second lease waits once the first used it", async () => {
    const clock = createFakeClock(0);
    const g = createSafetyGuard({ maxRps: 100 }, { interactive: false, clock });
    const a = g.reserve({});
    const b = g.reserve({});
    // burst = 10 cells at t=0, shared by both leases
    for (let i = 0; i < 10; i++) expect(await a.throttle()).toBe(false);
    const pb = b.throttle();
    expect(await settled(pb)).toBe(false); // before the fix b had its own fresh burst of 10
    clock.advance(10); // 1 / 100 rps
    expect(await pb).toBe(true);
    a.release();
    b.release();
  });

  it("aggregate grants of N leases over 1 s stay within maxRps + burst", async () => {
    const clock = createFakeClock(0);
    const g = createSafetyGuard({ maxRps: 100 }, { interactive: false, clock });
    const leases = [g.reserve({}), g.reserve({}), g.reserve({})];
    let grants = 0;
    const stop = new AbortController();
    const workers = leases.map(async (l) => {
      for (;;) {
        try {
          await l.throttle(stop.signal);
        } catch {
          return;
        }
        grants++;
      }
    });
    for (let t = 0; t < 1000; t++) {
      clock.advance(1);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    stop.abort();
    clock.advance(1000);
    await Promise.all(workers);
    // 100 per second + burst 10 (+1 boundary); per-lease limiters would give ~3× this
    expect(grants).toBeLessThanOrEqual(111);
    expect(grants).toBeGreaterThanOrEqual(90);
    for (const l of leases) l.release();
  });

  it("a lease with a lower maxRps is paced by its own limiter and still counts against the world cap", async () => {
    const clock = createFakeClock(0);
    const g = createSafetyGuard({ maxRps: 100 }, { interactive: false, clock });
    const slow = g.reserve({ maxRps: 10 }); // burst 1, interval 100 ms
    const fast = g.reserve({});
    expect(await slow.throttle()).toBe(false);
    const p = slow.throttle();
    clock.advance(50);
    expect(await settled(p)).toBe(false); // world cap would allow it; the lease's own 10/s does not
    clock.advance(50);
    expect(await p).toBe(true);
    // slow took 2 of the shared burst of 10 → fast gets only 8 more without waiting
    let free = 0;
    for (;;) {
      const q = fast.throttle();
      if (!(await settled(q))) {
        clock.advance(100);
        await q;
        break;
      }
      free++;
    }
    expect(free).toBeLessThanOrEqual(9);
    slow.release();
    fast.release();
  });

  it("no world-wide limiter when maxRps is not finite; a lease limit still applies", async () => {
    const clock = createFakeClock(0);
    const g = createSafetyGuard({ maxRps: Number.POSITIVE_INFINITY }, { interactive: false, clock });
    const free = g.reserve({});
    for (let i = 0; i < 1000; i++) expect(await free.throttle()).toBe(false);
    const capped = g.reserve({ maxRps: 10 });
    expect(await capped.throttle()).toBe(false);
    expect(await settled(capped.throttle())).toBe(false);
    free.release();
    capped.release();
  });
});
