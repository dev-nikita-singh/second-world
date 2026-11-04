/**
 * Closed-loop scheduler start instants (docs/03-engines/performance-lab.md §2, §7). Timers may fire early
 * relative to the monotonic clock (libuv's loop time is ms-truncated: on Linux setTimeout wakes up to
 * ~1.5 ms before performance.now() reaches the deadline). Worker shards share a future t0, so a VU that
 * started early would put its first iteration before warmupEnd, where it is silently counted as warmup
 * (wave 9: 100 of 101 requests reported, scenario iterations ≠ total iterations).
 */
import { describe, expect, it } from "vitest";
import type { Clock } from "../../../src/core/types.js";
import { runClosed } from "../../../src/engines/performance/scheduler/closed.js";
import { runIterations } from "../../../src/engines/performance/scheduler/iterations.js";

/** A clock whose sleeps wake `earlyMs` before their deadline (never before `now`). */
function earlyClock(earlyMs: number): Clock & { sleeps: number } {
  let now = 1000;
  const c = {
    sleeps: 0,
    now: () => now,
    isoNow: () => new Date(0).toISOString(),
    async sleep(ms: number): Promise<void> {
      c.sleeps++;
      const wakeAt = now + Math.max(0.1, ms - earlyMs);
      await Promise.resolve();
      now = Math.max(now, wakeAt);
    },
  };
  return c;
}

describe("closed scheduler: a VU never starts before its scheduled instant", () => {
  it("re-sleeps when the timer fires early (shared future t0)", async () => {
    const clock = earlyClock(1.5);
    const t0 = clock.now() + 20;
    const starts: number[] = [];
    await runClosed({
      vus: 4,
      rampUpMs: 0,
      totalMs: 50,
      clock,
      signal: new AbortController().signal,
      t0,
      think: () => 0,
      claim: (() => {
        let left = 4;
        return () => left-- > 0;
      })(),
      iteration: async () => {
        starts.push(clock.now());
      },
    });
    expect(starts).toHaveLength(4);
    for (const s of starts) expect(s).toBeGreaterThanOrEqual(t0);
    expect(clock.sleeps).toBeGreaterThan(4); // the early wake-ups were followed by a second sleep
  });

  it("ramp-up offsets are honoured too", async () => {
    const clock = earlyClock(3);
    const t0 = clock.now() + 10;
    const starts = new Map<number, number>();
    await runIterations({
      iterations: 5,
      vus: 5,
      rampUpMs: 100,
      totalMs: 1000,
      clock,
      signal: new AbortController().signal,
      t0,
      think: () => 0,
      iteration: async (vu) => {
        if (!starts.has(vu)) starts.set(vu, clock.now());
      },
    });
    for (const [vu, s] of starts) expect(s).toBeGreaterThanOrEqual(t0 + (100 * vu) / 5);
  });
});
