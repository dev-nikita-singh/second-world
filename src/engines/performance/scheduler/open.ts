/**
 * Open-loop (arrival-rate) scheduler. See docs/04-data-structures-and-algorithms.md §3.2, §3.3, §3.5.
 *
 * - Drift-free: the i-th intended start is computed from i (t0 + i·1000/rate), never by chaining timers.
 * - Poisson: unit-rate exponential gaps from the seeded RNG, time-changed through the rate curve,
 *   which also yields a correct non-homogeneous process during ramp-up.
 * - Wake strategy: sleep for the coarse part, then setImmediate spin for the last `spinMs`.
 * - Catch-up: every arrival whose intended time has passed is released at once (lag is recorded).
 * - Latency is measured by the caller from the INTENDED start (coordinated-omission correction).
 * - If in-flight would exceed `maxInFlight`, the arrival is counted as dropped, never delayed.
 */
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { Clock, Rng } from "../../../core/types.js";
import { LatencyHistogram } from "../../../shared/stats/hdr.js";

export interface ArrivalCurve {
  /** Target rate in arrivals per second (after ramp-up). */
  rate: number;
  arrival: "constant" | "poisson";
  /** Linear ramp from 0 to `rate` over this many ms. */
  rampUpMs: number;
  /** Schedule length in ms (arrivals with offset >= totalMs are not generated). */
  totalMs: number;
  /** Required for Poisson. */
  rng?: Rng;
  /**
   * worker_threads sharding (docs/03-engines/performance-lab.md §7): this generator produces only
   * its share of the global curve. Constant: global arrivals index, index+count, index+2·count, …
   * (exact interleaving with offset phases). Poisson: an independent Poisson process at rate/count
   * (the superposition of `count` such processes is Poisson at `rate`).
   */
  shard?: { count: number; index: number };
}

/** Inverse of the cumulative arrival curve N(t): offset (ms) at which the x-th arrival is due. */
export function offsetForCount(x: number, rate: number, rampUpMs: number): number {
  // Written as (x·1000)/rate so the constant schedule is exactly t0 + i·1000/rate.
  if (rampUpMs > 0) {
    const rampCount = (rate * rampUpMs) / 2000;
    if (x < rampCount) return Math.sqrt((2000 * rampUpMs * x) / rate);
    return rampUpMs + ((x - rampCount) * 1000) / rate;
  }
  return (x * 1000) / rate;
}

/** Expected number of arrivals in [fromMs, toMs) of the curve. */
export function expectedArrivals(
  curve: Pick<ArrivalCurve, "rate" | "rampUpMs">,
  fromMs: number,
  toMs: number,
): number {
  const n = (t: number): number => {
    const r = curve.rate / 1000;
    const R = curve.rampUpMs;
    if (t <= 0) return 0;
    if (R > 0 && t < R) return (r * t * t) / (2 * R);
    return R > 0 ? (r * R) / 2 + r * (t - R) : r * t;
  };
  return n(toMs) - n(fromMs);
}

/** Lazily generates intended start offsets (ms from t0). O(1) memory. */
export function* arrivalOffsets(curve: ArrivalCurve): Generator<number, void, undefined> {
  if (curve.rate <= 0 || curve.totalMs <= 0) return;
  const stride = Math.max(1, Math.floor(curve.shard?.count ?? 1));
  const phase = Math.min(stride - 1, Math.max(0, Math.floor(curve.shard?.index ?? 0)));
  if (curve.arrival === "constant") {
    for (let i = 0; ; i++) {
      const t = offsetForCount(i * stride + phase, curve.rate, curve.rampUpMs);
      if (t >= curve.totalMs) return;
      yield t;
    }
  }
  const rng = curve.rng;
  if (!rng) throw new Error("poisson arrivals require an rng");
  let x = 0;
  for (;;) {
    x += rng.exponential(stride);
    const t = offsetForCount(x, curve.rate, curve.rampUpMs);
    if (t >= curve.totalMs) return;
    yield t;
  }
}

export interface OpenSchedulerOptions extends ArrivalCurve {
  clock: Clock;
  /** Stops scheduling when aborted (in-flight arrivals are left to the caller). */
  signal: AbortSignal;
  maxInFlight: number;
  /** Final busy-wait window in ms (0 disables spinning; use with fake clocks). */
  spinMs: number;
  /** Clock ms used as t0 (default: clock.now() at start). */
  t0?: number;
  /** Starts one arrival. Must not throw synchronously; rejections are swallowed. */
  onArrival(intendedMs: number, index: number): Promise<unknown>;
  onDrop?(intendedMs: number, index: number): void;
}

export interface OpenSchedulerResult {
  t0: number;
  scheduled: number;
  released: number;
  dropped: number;
  /** Scheduling lag (actual release − intended), µs. */
  lag: LatencyHistogram;
  /** Total ms spent busy-waiting (excluded from generator CPU accounting). */
  spinMs: number;
  /** Arrivals still running when the schedule ended. */
  pending: Set<Promise<unknown>>;
  /** Live in-flight count getter. */
  inFlight(): number;
}

export async function runOpenSchedule(opts: OpenSchedulerOptions): Promise<OpenSchedulerResult> {
  const { clock, signal } = opts;
  const t0 = opts.t0 ?? clock.now();
  const lag = new LatencyHistogram({ digits: 2 });
  const pending = new Set<Promise<unknown>>();
  let inFlight = 0;
  let scheduled = 0;
  let released = 0;
  let dropped = 0;
  let spinTotal = 0;
  const it = arrivalOffsets(opts);
  let next = it.next();
  let index = 0;

  while (!next.done && !signal.aborted) {
    let now = clock.now();
    const wait = t0 + next.value - now;
    if (wait > 0) {
      if (wait > opts.spinMs) {
        try {
          await clock.sleep(wait - opts.spinMs, signal);
        } catch {
          // aborted: loop condition handles it
        }
      } else {
        const s = clock.now();
        await yieldImmediate();
        spinTotal += clock.now() - s;
      }
      continue;
    }
    // Release every arrival that is due (catch-up burst).
    while (!next.done && t0 + next.value <= now) {
      const intended = t0 + next.value;
      const i = index++;
      scheduled++;
      lag.record(Math.round((now - intended) * 1000));
      if (inFlight >= opts.maxInFlight) {
        dropped++;
        opts.onDrop?.(intended, i);
      } else {
        inFlight++;
        released++;
        const p: Promise<unknown> = opts
          .onArrival(intended, i)
          .catch(() => undefined)
          .finally(() => {
            inFlight--;
            pending.delete(p);
          });
        pending.add(p);
      }
      next = it.next();
      now = clock.now();
    }
  }
  return { t0, scheduled, released, dropped, lag, spinMs: spinTotal, pending, inFlight: () => inFlight };
}
