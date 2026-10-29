/**
 * Counting semaphore (bounded concurrency) — docs/04-data-structures-and-algorithms.md §2.1.
 *
 * FIFO-fair: waiters queue in a growable ring buffer and a released permit is handed
 * directly to the next waiter (no thundering herd, no barging). Aborting a waiting
 * acquire removes it from the queue and rejects with `signal.reason`.
 * The release function returned by acquire is idempotent.
 */
import { RingBuffer } from "./ring-buffer.js";

export type Release = () => void;

interface Waiter {
  grant: () => void;
}

export class Semaphore {
  private permits: number;
  private readonly waiters = new RingBuffer<Waiter>(16, { grow: true });
  readonly max: number;

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`Semaphore max must be a positive integer, got ${max}`);
    }
    this.max = max;
    this.permits = max;
  }

  /** Free permits right now. */
  get available(): number {
    return this.permits;
  }

  /** Number of queued acquirers. */
  get waiting(): number {
    return this.waiters.size;
  }

  /** Permits currently held. */
  get inUse(): number {
    return this.max - this.permits;
  }

  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.permits > 0 && this.waiters.size === 0) {
      this.permits--;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise<Release>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.waiters.remove(waiter)) reject(signal?.reason);
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(this.releaseOnce());
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Acquire synchronously if a permit is free (and nobody is queued), else null. */
  tryAcquire(): Release | null {
    if (this.permits > 0 && this.waiters.size === 0) {
      this.permits--;
      return this.releaseOnce();
    }
    return null;
  }

  private releaseOnce(): Release {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next.grant();
      else this.permits++;
    };
  }
}
