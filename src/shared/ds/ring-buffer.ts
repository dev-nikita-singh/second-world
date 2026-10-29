/**
 * Ring buffer / deque — docs/04-data-structures-and-algorithms.md §2.2.
 *
 * Circular array with power-of-two capacity; indices wrap via `& mask`.
 * O(1) push / shift / pop. Three behaviours when full:
 *  - default: `push` rejects (returns false),
 *  - `grow: true`: capacity doubles (amortised O(1)),
 *  - `overwrite: true`: oldest element is dropped (fixed memory; push returns false to signal the drop).
 */

export interface RingBufferOptions {
  /** Double capacity when full instead of rejecting. */
  grow?: boolean;
  /** Drop the oldest element when full (bounded memory). Ignored if `grow` is set. */
  overwrite?: boolean;
}

function nextPow2(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export class RingBuffer<T> implements Iterable<T> {
  private buf: (T | undefined)[];
  private mask: number;
  private head = 0; // index of oldest element
  private len = 0;
  private readonly grow: boolean;
  private readonly overwrite: boolean;
  /** Number of elements dropped in overwrite mode. */
  dropped = 0;

  constructor(capacity: number, options: RingBufferOptions = {}) {
    const cap = nextPow2(Math.floor(capacity));
    this.buf = new Array<T | undefined>(cap);
    this.mask = cap - 1;
    this.grow = options.grow === true;
    this.overwrite = !this.grow && options.overwrite === true;
  }

  get size(): number {
    return this.len;
  }

  get capacity(): number {
    return this.mask + 1;
  }

  get isFull(): boolean {
    return this.len === this.mask + 1;
  }

  get isEmpty(): boolean {
    return this.len === 0;
  }

  /**
   * Append at the tail. Returns true if stored without loss; false if rejected
   * (full, no grow/overwrite) or if the oldest element was overwritten to make room.
   */
  push(value: T): boolean {
    if (this.len === this.mask + 1) {
      if (this.grow) {
        this.resize((this.mask + 1) * 2);
      } else if (this.overwrite) {
        this.buf[this.head] = value;
        this.head = (this.head + 1) & this.mask;
        this.dropped++;
        return false;
      } else {
        return false;
      }
    }
    this.buf[(this.head + this.len) & this.mask] = value;
    this.len++;
    return true;
  }

  /** Remove and return the oldest element. */
  shift(): T | undefined {
    if (this.len === 0) return undefined;
    const v = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) & this.mask;
    this.len--;
    return v;
  }

  /** Remove and return the newest element. */
  pop(): T | undefined {
    if (this.len === 0) return undefined;
    const i = (this.head + this.len - 1) & this.mask;
    const v = this.buf[i];
    this.buf[i] = undefined;
    this.len--;
    return v;
  }

  /** Oldest element without removing it. */
  peek(): T | undefined {
    return this.len === 0 ? undefined : this.buf[this.head];
  }

  /** Newest element without removing it. */
  peekLast(): T | undefined {
    return this.len === 0 ? undefined : this.buf[(this.head + this.len - 1) & this.mask];
  }

  /** i-th element from the oldest (0-based); negative indexes from the newest. */
  at(i: number): T | undefined {
    const idx = i < 0 ? this.len + i : i;
    if (idx < 0 || idx >= this.len) return undefined;
    return this.buf[(this.head + idx) & this.mask];
  }

  /** Remove the first occurrence (by ===). O(n). Returns true if found. */
  remove(value: T): boolean {
    for (let k = 0; k < this.len; k++) {
      if (this.buf[(this.head + k) & this.mask] === value) {
        // shift later elements one slot towards head
        for (let j = k; j < this.len - 1; j++) {
          this.buf[(this.head + j) & this.mask] = this.buf[(this.head + j + 1) & this.mask];
        }
        this.buf[(this.head + this.len - 1) & this.mask] = undefined;
        this.len--;
        return true;
      }
    }
    return false;
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.len = 0;
  }

  toArray(): T[] {
    const out = new Array<T>(this.len);
    for (let k = 0; k < this.len; k++) out[k] = this.buf[(this.head + k) & this.mask] as T;
    return out;
  }

  *[Symbol.iterator](): Iterator<T> {
    for (let k = 0; k < this.len; k++) yield this.buf[(this.head + k) & this.mask] as T;
  }

  private resize(newCap: number): void {
    const next = new Array<T | undefined>(newCap);
    for (let k = 0; k < this.len; k++) next[k] = this.buf[(this.head + k) & this.mask];
    this.buf = next;
    this.head = 0;
    this.mask = newCap - 1;
  }
}
