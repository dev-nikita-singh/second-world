/**
 * Closed-loop (virtual users) and iterations schedulers. See docs/04-data-structures-and-algorithms.md §3.1.
 *
 * VU i starts at t0 + rampUp·i/N, then loops: iteration → think time → repeat, until the end
 * time, the signal, or (iterations model) the shared iteration counter is exhausted.
 * Concurrency is naturally bounded by N.
 */
import type { Clock } from "../../../core/types.js";

export interface ClosedSchedulerOptions {
  vus: number;
  rampUpMs: number;
  /** Stop starting iterations after t0 + totalMs. */
  totalMs: number;
  clock: Clock;
  /** Stops starting new iterations when aborted. */
  signal: AbortSignal;
  t0?: number;
  /** Think time in ms after each iteration (sampled per call). */
  think(): number;
  /** Runs one iteration for VU `vu`. Rejections are swallowed. */
  iteration(vu: number, iterationIndex: number): Promise<unknown>;
  /** Iterations model: returns false when no work is left. */
  claim?(): boolean;
  /** Start offset (ms from t0) of local VU i. Default: vuStartOffset(i, vus, rampUpMs). Sharding maps local VUs onto the global ramp. */
  startOffset?(i: number): number;
}

export interface ClosedSchedulerResult {
  t0: number;
  iterations: number;
  /** VUs that actually started. */
  startedVus: number;
}

/** Start offset of VU i (ms from t0). */
export function vuStartOffset(i: number, vus: number, rampUpMs: number): number {
  return vus <= 0 ? 0 : (rampUpMs * i) / vus;
}

export async function runClosed(opts: ClosedSchedulerOptions): Promise<ClosedSchedulerResult> {
  const { clock, signal } = opts;
  const t0 = opts.t0 ?? clock.now();
  const end = t0 + opts.totalMs;
  let iterations = 0;
  let startedVus = 0;

  const vu = async (i: number): Promise<void> => {
    const startAt = t0 + (opts.startOffset ? opts.startOffset(i) : vuStartOffset(i, opts.vus, opts.rampUpMs));
    // Timers may fire early relative to the monotonic clock (libuv's loop time is ms-truncated and
    // cached: on Linux setTimeout wakes up to ~1.5 ms before performance.now() reaches the deadline).
    // A VU must never start before its scheduled instant: with a shared future t0 (worker shards)
    // an early first iteration would land before warmupEnd and be silently classed as warmup.
    for (let wait = startAt - clock.now(); wait > 0; wait = startAt - clock.now()) {
      try {
        await clock.sleep(wait, signal);
      } catch {
        return;
      }
    }
    if (signal.aborted || clock.now() >= end) return;
    startedVus++;
    while (!signal.aborted && clock.now() < end) {
      if (opts.claim && !opts.claim()) return;
      const n = iterations++;
      try {
        await opts.iteration(i, n);
      } catch {
        // counted by the iteration itself
      }
      const think = opts.think();
      if (think > 0 && !signal.aborted) {
        try {
          await clock.sleep(Math.min(think, Math.max(0, end - clock.now())), signal);
        } catch {
          return;
        }
      }
    }
  };

  const all: Promise<void>[] = [];
  for (let i = 0; i < opts.vus; i++) all.push(vu(i));
  await Promise.all(all);
  return { t0, iterations, startedVus };
}
