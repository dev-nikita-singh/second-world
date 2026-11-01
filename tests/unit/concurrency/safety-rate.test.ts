/**
 * In-process async races on the Safety Guard rate cap (Plan wave 7 §A, docs/04 §3.4 GCRA,
 * docs/11-safety-security-privacy.md "hard budgets"). Real clock; windows are generous so CPU noise
 * cannot make an honest limiter fail.
 */
import { describe, expect, it } from "vitest";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";

/** Most grants in any sliding window of `windowMs`. */
function maxInWindow(times: number[], windowMs: number): number {
  const t = [...times].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < t.length; hi++) {
    while ((t[hi] as number) - (t[lo] as number) >= windowMs) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

async function hammer(throttle: () => Promise<unknown>, workers: number, ms: number): Promise<number[]> {
  const grants: number[] = [];
  const end = performance.now() + ms;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (performance.now() < end) {
        await throttle();
        grants.push(performance.now());
      }
    }),
  );
  return grants;
}

describe("safety rate cap under concurrent callers", () => {
  it("50 concurrent VUs on one lease never exceed maxRps (+burst) in any 500 ms window", async () => {
    const g = createSafetyGuard({ maxRps: 200 }, { interactive: false });
    const lease = g.reserve({});
    const grants = await hammer(() => lease.throttle(), 50, 1500);
    lease.release();
    // 200/s → 100 per 500 ms, burst = ceil(200/10) = 20
    expect(maxInWindow(grants, 500)).toBeLessThanOrEqual(100 + 20 + 1);
    expect(grants.length).toBeGreaterThan(150); // it does let traffic through
  });

  // Was a bug (sw-race7, wave 7): each lease had its own GCRA, so two leases got maxRps each
  // (238 grants in 500 ms at a 200/s cap). Fixed by main: one world-wide GCRA in the guard.
  it("two concurrent leases share safety.maxRps (aggregate stays under the cap)", async () => {
    const g = createSafetyGuard({ maxRps: 200 }, { interactive: false });
    const a = g.reserve({});
    const b = g.reserve({});
    const [ga, gb] = await Promise.all([
      hammer(() => a.throttle(), 25, 1500),
      hammer(() => b.throttle(), 25, 1500),
    ]);
    a.release();
    b.release();
    expect(maxInWindow([...ga, ...gb], 500)).toBeLessThanOrEqual(100 + 20 + 1);
  });
});
