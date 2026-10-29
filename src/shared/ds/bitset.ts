/**
 * Fixed-size bitset over a Uint32Array with fast popcount — docs/04-data-structures-and-algorithms.md §2.5.
 * Used for coverage tracking (operation × status × schema-branch).
 */

function popcount32(x: number): number {
  let v = x >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) >>> 0;
}

export class Bitset {
  readonly words: Uint32Array;

  constructor(readonly length: number) {
    if (!Number.isInteger(length) || length < 0)
      throw new RangeError("Bitset length must be a non-negative integer");
    this.words = new Uint32Array(Math.ceil(length / 32));
  }

  private check(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.length)
      throw new RangeError(`Bitset index out of range: ${i}`);
  }

  set(i: number): this {
    this.check(i);
    this.words[i >>> 5] = ((this.words[i >>> 5] as number) | (1 << (i & 31))) >>> 0;
    return this;
  }

  clear(i: number): this {
    this.check(i);
    this.words[i >>> 5] = ((this.words[i >>> 5] as number) & ~(1 << (i & 31))) >>> 0;
    return this;
  }

  /** Set bit i; returns true if it was previously unset (new coverage). */
  testAndSet(i: number): boolean {
    const was = this.test(i);
    if (!was) this.set(i);
    return !was;
  }

  test(i: number): boolean {
    this.check(i);
    return (((this.words[i >>> 5] as number) >>> (i & 31)) & 1) === 1;
  }

  /** Number of set bits. */
  count(): number {
    let c = 0;
    for (let k = 0; k < this.words.length; k++) c += popcount32(this.words[k] as number);
    return c;
  }

  /** Fraction of bits set (0 when length is 0). */
  ratio(): number {
    return this.length === 0 ? 0 : this.count() / this.length;
  }

  /** In-place OR with a same-length bitset. */
  or(other: Bitset): this {
    if (other.length !== this.length) throw new RangeError("Bitset length mismatch");
    for (let k = 0; k < this.words.length; k++)
      this.words[k] = ((this.words[k] as number) | (other.words[k] as number)) >>> 0;
    return this;
  }

  /** In-place AND with a same-length bitset. */
  and(other: Bitset): this {
    if (other.length !== this.length) throw new RangeError("Bitset length mismatch");
    for (let k = 0; k < this.words.length; k++)
      this.words[k] = ((this.words[k] as number) & (other.words[k] as number)) >>> 0;
    return this;
  }

  reset(): void {
    this.words.fill(0);
  }

  clone(): Bitset {
    const b = new Bitset(this.length);
    b.words.set(this.words);
    return b;
  }

  /** Indexes of set bits, ascending. */
  toArray(): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.words.length; k++) {
      let w = this.words[k] as number;
      while (w !== 0) {
        const t = w & -w;
        out.push(k * 32 + (31 - Math.clz32(t)));
        w = (w ^ t) >>> 0;
      }
    }
    return out;
  }
}
