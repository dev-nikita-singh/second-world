/**
 * Binary min-heap (priority queue) — docs/04-data-structures-and-algorithms.md §2.3.
 * - `MinHeap<T>`: generic, user comparator.
 * - `KeyedMinHeap<T>`: numeric keys in a growable Float64Array (no per-item key objects) — for
 *   scheduler/timer queues keyed by time. Ties pop in insertion order (FIFO-stable via a sequence).
 * - `TopK<T>`: keeps the k largest items by a numeric score (min-heap of size k).
 */

export class MinHeap<T> {
  private readonly a: T[] = [];
  constructor(private readonly compare: (x: T, y: T) => number) {}

  get size(): number {
    return this.a.length;
  }

  push(v: T): void {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.compare(a[i] as T, a[p] as T) >= 0) break;
      [a[i], a[p]] = [a[p] as T, a[i] as T];
      i = p;
    }
  }

  peek(): T | undefined {
    return this.a[0];
  }

  pop(): T | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0] as T;
    const last = a.pop() as T;
    if (a.length > 0) {
      a[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** Pop then push in one sift (requires non-empty heap). */
  replaceTop(v: T): T | undefined {
    if (this.a.length === 0) {
      this.push(v);
      return undefined;
    }
    const top = this.a[0];
    this.a[0] = v;
    this.siftDown(0);
    return top;
  }

  clear(): void {
    this.a.length = 0;
  }

  /** Unordered snapshot. */
  toArray(): T[] {
    return this.a.slice();
  }

  private siftDown(i: number): void {
    const a = this.a;
    const n = a.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.compare(a[l] as T, a[m] as T) < 0) m = l;
      if (r < n && this.compare(a[r] as T, a[m] as T) < 0) m = r;
      if (m === i) return;
      [a[i], a[m]] = [a[m] as T, a[i] as T];
      i = m;
    }
  }
}

/** Min-heap over numeric keys stored in typed arrays. Equal keys pop FIFO. */
export class KeyedMinHeap<T> {
  private keys: Float64Array;
  private seqs: Float64Array;
  private vals: (T | undefined)[];
  private n = 0;
  private seq = 0;

  constructor(initialCapacity = 64) {
    const c = Math.max(1, initialCapacity);
    this.keys = new Float64Array(c);
    this.seqs = new Float64Array(c);
    this.vals = new Array<T | undefined>(c);
  }

  get size(): number {
    return this.n;
  }

  private less(i: number, j: number): boolean {
    const ki = this.keys[i] as number;
    const kj = this.keys[j] as number;
    return ki < kj || (ki === kj && (this.seqs[i] as number) < (this.seqs[j] as number));
  }

  private swap(i: number, j: number): void {
    const k = this.keys[i] as number;
    this.keys[i] = this.keys[j] as number;
    this.keys[j] = k;
    const s = this.seqs[i] as number;
    this.seqs[i] = this.seqs[j] as number;
    this.seqs[j] = s;
    const v = this.vals[i];
    this.vals[i] = this.vals[j];
    this.vals[j] = v;
  }

  push(key: number, value: T): void {
    if (this.n === this.keys.length) {
      const c = this.keys.length * 2;
      const k = new Float64Array(c);
      k.set(this.keys);
      const s = new Float64Array(c);
      s.set(this.seqs);
      this.keys = k;
      this.seqs = s;
      this.vals.length = c;
    }
    let i = this.n++;
    this.keys[i] = key;
    this.seqs[i] = this.seq++;
    this.vals[i] = value;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  peekKey(): number | undefined {
    return this.n === 0 ? undefined : this.keys[0];
  }

  peek(): T | undefined {
    return this.n === 0 ? undefined : this.vals[0];
  }

  pop(): T | undefined {
    if (this.n === 0) return undefined;
    const top = this.vals[0];
    this.n--;
    if (this.n > 0) {
      this.keys[0] = this.keys[this.n] as number;
      this.seqs[0] = this.seqs[this.n] as number;
      this.vals[0] = this.vals[this.n];
    }
    this.vals[this.n] = undefined;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.n && this.less(l, m)) m = l;
      if (r < this.n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }

  clear(): void {
    this.vals.fill(undefined);
    this.n = 0;
  }
}

/** Keeps the k items with the largest score. O(log k) per offer. */
export class TopK<T> {
  private readonly heap: MinHeap<{ s: number; v: T }>;
  constructor(readonly k: number) {
    this.heap = new MinHeap((x, y) => x.s - y.s);
  }

  offer(score: number, value: T): void {
    if (this.k <= 0) return;
    if (this.heap.size < this.k) this.heap.push({ s: score, v: value });
    else if (score > (this.heap.peek()?.s ?? Number.NEGATIVE_INFINITY))
      this.heap.replaceTop({ s: score, v: value });
  }

  get size(): number {
    return this.heap.size;
  }

  /** Items sorted by descending score. */
  items(): { score: number; value: T }[] {
    return this.heap
      .toArray()
      .sort((a, b) => b.s - a.s)
      .map((e) => ({ score: e.s, value: e.v }));
  }
}
