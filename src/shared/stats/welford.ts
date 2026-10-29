/**
 * Welford online mean/variance with Chan et al. parallel merge —
 * docs/04-data-structures-and-algorithms.md §4.2.
 */
export class Welford {
  private n = 0;
  private m = 0;
  private m2 = 0;
  private lo = Number.POSITIVE_INFINITY;
  private hi = Number.NEGATIVE_INFINITY;

  push(x: number): void {
    this.n++;
    const d = x - this.m;
    this.m += d / this.n;
    this.m2 += d * (x - this.m);
    if (x < this.lo) this.lo = x;
    if (x > this.hi) this.hi = x;
  }

  /** Merge another accumulator into this one in O(1). */
  merge(o: Welford): void {
    if (o.n === 0) return;
    if (this.n === 0) {
      this.n = o.n;
      this.m = o.m;
      this.m2 = o.m2;
      this.lo = o.lo;
      this.hi = o.hi;
      return;
    }
    const n = this.n + o.n;
    const d = o.m - this.m;
    this.m += (d * o.n) / n;
    this.m2 += o.m2 + (d * d * this.n * o.n) / n;
    this.n = n;
    if (o.lo < this.lo) this.lo = o.lo;
    if (o.hi > this.hi) this.hi = o.hi;
  }

  reset(): void {
    this.n = 0;
    this.m = 0;
    this.m2 = 0;
    this.lo = Number.POSITIVE_INFINITY;
    this.hi = Number.NEGATIVE_INFINITY;
  }

  get count(): number {
    return this.n;
  }
  get mean(): number {
    return this.n === 0 ? 0 : this.m;
  }
  /** Sample variance (n − 1). 0 when n < 2. */
  get variance(): number {
    return this.n < 2 ? 0 : this.m2 / (this.n - 1);
  }
  /** Population variance (n). */
  get populationVariance(): number {
    return this.n === 0 ? 0 : this.m2 / this.n;
  }
  get stdDev(): number {
    return Math.sqrt(this.variance);
  }
  get min(): number {
    return this.n === 0 ? 0 : this.lo;
  }
  get max(): number {
    return this.n === 0 ? 0 : this.hi;
  }
}
