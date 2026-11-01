/**
 * Read cache for order views: LRU (Map insertion order) with a size bound and a TTL, so it can
 * neither grow without bound nor serve an entry forever. Callers must invalidate on writes.
 */
export class ReadCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e || e.expires <= this.now()) {
      if (e) this.entries.delete(key);
      this.misses++;
      return undefined;
    }
    // refresh recency
    this.entries.delete(key);
    this.entries.set(key, e);
    this.hits++;
    return e.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}
