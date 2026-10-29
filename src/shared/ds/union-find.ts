/**
 * Union-find (disjoint set union) with union by rank + path compression —
 * docs/04-data-structures-and-algorithms.md §5.8. Iterative find (no recursion).
 * `UnionFind` works on dense integer ids (Int32Array); `KeyedUnionFind` maps string keys.
 */
export class UnionFind {
  private parent: Int32Array;
  private rank: Uint8Array;
  private n: number;
  private sets: number;

  constructor(n: number) {
    this.parent = new Int32Array(Math.max(4, n));
    this.rank = new Uint8Array(this.parent.length);
    for (let i = 0; i < n; i++) this.parent[i] = i;
    this.n = n;
    this.sets = n;
  }

  get size(): number {
    return this.n;
  }

  /** Number of disjoint sets. */
  get count(): number {
    return this.sets;
  }

  /** Append a new singleton (amortised O(1)); returns its id. */
  add(): number {
    if (this.n === this.parent.length) {
      const p = new Int32Array(this.parent.length * 2);
      p.set(this.parent);
      const r = new Uint8Array(p.length);
      r.set(this.rank);
      this.parent = p;
      this.rank = r;
    }
    const id = this.n++;
    this.parent[id] = id;
    this.sets++;
    return id;
  }

  find(x: number): number {
    if (!(x >= 0 && x < this.n)) throw new RangeError(`UnionFind id out of range: ${x}`);
    let r = x;
    while ((this.parent[r] as number) !== r) r = this.parent[r] as number;
    // path compression
    let c = x;
    while (c !== r) {
      const next = this.parent[c] as number;
      this.parent[c] = r;
      c = next;
    }
    return r;
  }

  /** Merge the sets of a and b; returns false if already joined. */
  union(a: number, b: number): boolean {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if ((this.rank[ra] as number) < (this.rank[rb] as number)) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra] = (this.rank[ra] as number) + 1;
    this.sets--;
    return true;
  }

  connected(a: number, b: number): boolean {
    return this.find(a) === this.find(b);
  }
}

/** Union-find over string keys (keys are added on first use). */
export class KeyedUnionFind {
  private readonly ids = new Map<string, number>();
  private readonly keys: string[] = [];
  private uf = new UnionFind(0);

  private id(key: string): number {
    let i = this.ids.get(key);
    if (i === undefined) {
      i = this.uf.add();
      this.ids.set(key, i);
      this.keys.push(key);
    }
    return i;
  }

  add(key: string): void {
    this.id(key);
  }

  has(key: string): boolean {
    return this.ids.has(key);
  }

  union(a: string, b: string): boolean {
    return this.uf.union(this.id(a), this.id(b));
  }

  /** Representative key of the set containing `key`. */
  find(key: string): string {
    return this.keys[this.uf.find(this.id(key))] as string;
  }

  connected(a: string, b: string): boolean {
    if (!this.ids.has(a) || !this.ids.has(b)) return a === b;
    return this.uf.connected(this.id(a), this.id(b));
  }

  get count(): number {
    return this.uf.count;
  }

  /** All sets (keys in insertion order within each group; groups by first member). */
  groups(): string[][] {
    const byRoot = new Map<number, string[]>();
    for (let i = 0; i < this.keys.length; i++) {
      const r = this.uf.find(i);
      let g = byRoot.get(r);
      if (!g) {
        g = [];
        byRoot.set(r, g);
      }
      g.push(this.keys[i] as string);
    }
    return [...byRoot.values()];
  }
}
