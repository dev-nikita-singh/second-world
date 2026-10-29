/**
 * LRU cache over an insertion-ordered Map — docs/04-data-structures-and-algorithms.md §2.4.
 * get: delete + re-insert (most recent last). Overflow: evict `keys().next()` (least recent).
 */
export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    readonly max: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError("LRUCache max must be a positive integer");
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** Read without updating recency. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      const v = this.map.get(oldest) as V;
      this.map.delete(oldest);
      this.onEvict?.(oldest, v);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Keys from least to most recently used. */
  keys(): K[] {
    return [...this.map.keys()];
  }
}
