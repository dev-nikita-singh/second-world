/**
 * Generic Cell Rate Algorithm (exact token bucket storing only the theoretical arrival time).
 * See docs/04-data-structures-and-algorithms.md §3.4.
 *
 *   on request at t:  tat = max(TAT, t);  if tat − t > burstTolerance → reject/wait
 *                     else TAT = tat + 1/rate
 *
 * O(1) time and memory, no refill timer. Times in ms.
 */
import type { Clock } from "../types.js";

export interface GcraOptions {
  /** Cells per second (> 0). */
  rate: number;
  /** Max cells allowed back-to-back (>= 1). Default 1 (perfectly smooth). */
  burst?: number;
}

export interface GcraDecision {
  ok: boolean;
  /** When !ok: ms until the request would conform (Infinity if n > burst). */
  retryAfterMs: number;
}

export class Gcra {
  readonly intervalMs: number;
  readonly toleranceMs: number;
  readonly burst: number;
  readonly rate: number;
  private tat = Number.NEGATIVE_INFINITY;

  constructor(opts: GcraOptions) {
    if (!(opts.rate > 0) || !Number.isFinite(opts.rate)) {
      throw new RangeError("GCRA rate must be a positive finite number");
    }
    const burst = opts.burst ?? 1;
    if (!(burst >= 1)) throw new RangeError("GCRA burst must be >= 1");
    this.rate = opts.rate;
    this.burst = Math.floor(burst);
    this.intervalMs = 1000 / opts.rate;
    this.toleranceMs = (this.burst - 1) * this.intervalMs;
  }

  /** Attempts to take `n` cells at time `now` (ms). Only conforming requests update state. */
  tryTake(now: number, n = 1): GcraDecision {
    if (n <= 0) return { ok: true, retryAfterMs: 0 };
    if (n > this.burst) return { ok: false, retryAfterMs: Number.POSITIVE_INFINITY };
    const tat = Math.max(this.tat, now);
    const newTat = tat + n * this.intervalMs;
    const allowAt = newTat - this.toleranceMs - this.intervalMs;
    if (allowAt - now > 1e-9) return { ok: false, retryAfterMs: allowAt - now };
    this.tat = newTat;
    return { ok: true, retryAfterMs: 0 };
  }

  /** Waits (via clock.sleep) until `n` cells conform, then takes them. */
  /** Takes `n` cells, sleeping until they conform. Resolves `true` if it had to wait (the GCRA delayed the call). */
  async take(clock: Clock, n = 1, signal?: AbortSignal): Promise<boolean> {
    let waited = false;
    for (;;) {
      signal?.throwIfAborted();
      const d = this.tryTake(clock.now(), n);
      if (d.ok) return waited;
      waited = true;
      if (!Number.isFinite(d.retryAfterMs))
        throw new RangeError(`cannot take ${n} cells with burst ${this.burst}`);
      await clock.sleep(d.retryAfterMs, signal);
    }
  }

  reset(): void {
    this.tat = Number.NEGATIVE_INFINITY;
  }
}
