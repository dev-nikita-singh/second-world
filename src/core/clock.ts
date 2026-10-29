/**
 * Monotonic clock abstraction. See docs/02-architecture.md §4 and docs/06 §2 (Time).
 * Durations always come from performance.now(); wall time only for report timestamps.
 */
import type { Clock } from "./types.js";

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export const systemClock: Clock = {
  now: () => performance.now(),
  isoNow: () => new Date().toISOString(),
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const t = setTimeout(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      const onAbort = (): void => {
        clearTimeout(t);
        reject(abortReason(signal as AbortSignal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export interface FakeClock extends Clock {
  /** Advances time, resolving due sleepers in order. */
  advance(ms: number): void;
  /** Sets absolute time (must not go backwards). */
  set(ms: number): void;
  /** Number of pending sleepers. */
  readonly pending: number;
}

interface Sleeper {
  at: number;
  seq: number;
  resolve: () => void;
}

/**
 * Deterministic clock for tests. `sleep()` resolves only when `advance()` moves time past its deadline.
 * Wall time = startIso + elapsed.
 */
export function createFakeClock(startMs = 0, startIso = "2026-01-01T00:00:00.000Z"): FakeClock {
  let now = startMs;
  let seq = 0;
  const sleepers: Sleeper[] = [];
  const wall0 = Date.parse(startIso);

  function fire(): void {
    sleepers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    while (sleepers.length > 0 && (sleepers[0] as Sleeper).at <= now) {
      (sleepers.shift() as Sleeper).resolve();
    }
  }

  return {
    now: () => now,
    isoNow: () => new Date(wall0 + (now - startMs)).toISOString(),
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortReason(signal));
          return;
        }
        if (ms <= 0) {
          resolve();
          return;
        }
        const s: Sleeper = {
          at: now + ms,
          seq: seq++,
          resolve: () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        const onAbort = (): void => {
          const i = sleepers.indexOf(s);
          if (i >= 0) sleepers.splice(i, 1);
          reject(abortReason(signal as AbortSignal));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        sleepers.push(s);
      });
    },
    advance(ms: number): void {
      if (!(ms >= 0)) throw new RangeError("advance(ms) requires ms >= 0");
      now += ms;
      fire();
    },
    set(ms: number): void {
      if (ms < now) throw new RangeError("FakeClock cannot go backwards");
      now = ms;
      fire();
    },
    get pending() {
      return sleepers.length;
    },
  };
}
