/**
 * Reservoir sampling, Algorithm R (Vitter 1985) — docs/04-data-structures-and-algorithms.md §4.5.
 * Uniform sample of k items from a stream with fixed memory. Randomness is injected
 * (`rng(): number` in [0,1)) for determinism.
 */
export class Reservoir<T> {
  private readonly buf: T[] = [];
  private n = 0;

  constructor(
    readonly k: number,
    private readonly rng: () => number,
  ) {
    if (!Number.isInteger(k) || k < 0) throw new RangeError(`Reservoir k must be a non-negative integer`);
  }

  /** Offer an item; returns true if it was kept (possibly replacing an earlier one). */
  offer(x: T): boolean {
    this.n++;
    if (this.buf.length < this.k) {
      this.buf.push(x);
      return true;
    }
    if (this.k === 0) return false;
    const j = Math.floor(this.rng() * this.n); // uniform in [0, n)
    if (j < this.k) {
      this.buf[j] = x;
      return true;
    }
    return false;
  }

  /** Current sample (a copy). */
  get items(): T[] {
    return this.buf.slice();
  }

  /** Total items offered. */
  get seen(): number {
    return this.n;
  }

  get size(): number {
    return this.buf.length;
  }

  reset(): void {
    this.buf.length = 0;
    this.n = 0;
  }
}
