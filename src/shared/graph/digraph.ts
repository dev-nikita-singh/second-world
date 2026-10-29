/**
 * Directed graph with forward + reverse adjacency and multi-evidence edge data —
 * docs/04-data-structures-and-algorithms.md §5.1, §2.7 (CSR freeze for heavy analyses).
 *
 * `out: Map<id, Set<id>>`, `in: Map<id, Set<id>>`, `edgeData: Map<"from\0to", E[]>`.
 * Insertion order is preserved everywhere, which makes all algorithms deterministic.
 */

export interface Edge<E> {
  from: string;
  to: string;
  /** All evidence attached to this edge (possibly empty). */
  data: E[];
}

/** Compressed-sparse-row snapshot (dense integer ids). */
export interface CsrGraph {
  ids: string[];
  index: Map<string, number>;
  /** Successors of i are targets[offsets[i] .. offsets[i+1]). */
  offsets: Int32Array;
  targets: Int32Array;
  /** Predecessors of i are rTargets[rOffsets[i] .. rOffsets[i+1]). */
  rOffsets: Int32Array;
  rTargets: Int32Array;
}

const SEP = "\u0000";

export class DiGraph<N = unknown, E = unknown> {
  private readonly nodeMap = new Map<string, N | undefined>();
  private readonly out = new Map<string, Set<string>>();
  private readonly inn = new Map<string, Set<string>>();
  private readonly edgeMap = new Map<string, E[]>();

  /** Add a node (no-op if present; `data` overwrites when given). */
  addNode(id: string, data?: N): this {
    if (!this.nodeMap.has(id)) {
      this.nodeMap.set(id, data);
      this.out.set(id, new Set());
      this.inn.set(id, new Set());
    } else if (data !== undefined) {
      this.nodeMap.set(id, data);
    }
    return this;
  }

  /** Add an edge (adds missing nodes). Repeated adds append `data` as extra evidence. */
  addEdge(from: string, to: string, data?: E): this {
    this.addNode(from);
    this.addNode(to);
    const key = from + SEP + to;
    let list = this.edgeMap.get(key);
    if (!list) {
      list = [];
      this.edgeMap.set(key, list);
      (this.out.get(from) as Set<string>).add(to);
      (this.inn.get(to) as Set<string>).add(from);
    }
    if (data !== undefined) list.push(data);
    return this;
  }

  hasNode(id: string): boolean {
    return this.nodeMap.has(id);
  }

  hasEdge(from: string, to: string): boolean {
    return this.edgeMap.has(from + SEP + to);
  }

  nodeData(id: string): N | undefined {
    return this.nodeMap.get(id);
  }

  edgeData(from: string, to: string): E[] {
    return this.edgeMap.get(from + SEP + to) ?? [];
  }

  successors(id: string): string[] {
    const s = this.out.get(id);
    return s ? [...s] : [];
  }

  predecessors(id: string): string[] {
    const s = this.inn.get(id);
    return s ? [...s] : [];
  }

  /** Live (non-copied) neighbour set — for algorithms; do not mutate. */
  successorSet(id: string): ReadonlySet<string> | undefined {
    return this.out.get(id);
  }

  predecessorSet(id: string): ReadonlySet<string> | undefined {
    return this.inn.get(id);
  }

  outDegree(id: string): number {
    return this.out.get(id)?.size ?? 0;
  }

  inDegree(id: string): number {
    return this.inn.get(id)?.size ?? 0;
  }

  nodes(): string[] {
    return [...this.nodeMap.keys()];
  }

  edges(): Edge<E>[] {
    const res: Edge<E>[] = [];
    for (const [from, tos] of this.out) {
      for (const to of tos) res.push({ from, to, data: this.edgeMap.get(from + SEP + to) ?? [] });
    }
    return res;
  }

  get nodeCount(): number {
    return this.nodeMap.size;
  }

  get edgeCount(): number {
    return this.edgeMap.size;
  }

  removeEdge(from: string, to: string): boolean {
    const key = from + SEP + to;
    if (!this.edgeMap.delete(key)) return false;
    this.out.get(from)?.delete(to);
    this.inn.get(to)?.delete(from);
    return true;
  }

  removeNode(id: string): boolean {
    if (!this.nodeMap.has(id)) return false;
    for (const to of this.out.get(id) ?? []) {
      this.edgeMap.delete(id + SEP + to);
      this.inn.get(to)?.delete(id);
    }
    for (const from of this.inn.get(id) ?? []) {
      this.edgeMap.delete(from + SEP + id);
      this.out.get(from)?.delete(id);
    }
    this.out.delete(id);
    this.inn.delete(id);
    this.nodeMap.delete(id);
    return true;
  }

  /** Graph with every edge reversed (data copied by reference). */
  reverse(): DiGraph<N, E> {
    const g = new DiGraph<N, E>();
    for (const [id, d] of this.nodeMap) g.addNode(id, d);
    for (const e of this.edges()) {
      g.addEdge(e.to, e.from);
      for (const d of e.data) g.addEdge(e.to, e.from, d);
    }
    return g;
  }

  /** Induced subgraph on `ids`. */
  subgraph(ids: Iterable<string>): DiGraph<N, E> {
    const keep = new Set(ids);
    const g = new DiGraph<N, E>();
    for (const id of keep) if (this.nodeMap.has(id)) g.addNode(id, this.nodeMap.get(id));
    for (const id of keep) {
      for (const to of this.out.get(id) ?? []) {
        if (!keep.has(to)) continue;
        g.addEdge(id, to);
        for (const d of this.edgeData(id, to)) g.addEdge(id, to, d);
      }
    }
    return g;
  }

  /** Freeze into CSR with dense integer ids (insertion order). */
  toCsr(): CsrGraph {
    const ids = this.nodes();
    const index = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) index.set(ids[i] as string, i);
    const V = ids.length;
    const E = this.edgeMap.size;
    const offsets = new Int32Array(V + 1);
    const targets = new Int32Array(E);
    const rOffsets = new Int32Array(V + 1);
    const rTargets = new Int32Array(E);
    let k = 0;
    let r = 0;
    for (let i = 0; i < V; i++) {
      const id = ids[i] as string;
      offsets[i] = k;
      for (const to of this.out.get(id) as Set<string>) targets[k++] = index.get(to) as number;
      rOffsets[i] = r;
      for (const from of this.inn.get(id) as Set<string>) rTargets[r++] = index.get(from) as number;
    }
    offsets[V] = k;
    rOffsets[V] = r;
    return { ids, index, offsets, targets, rOffsets, rTargets };
  }
}
