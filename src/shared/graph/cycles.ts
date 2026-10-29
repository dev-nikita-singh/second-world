/**
 * Shortest example cycle inside an SCC via BFS — docs/04-data-structures-and-algorithms.md §5.2, §5.4.
 * A cycle is returned as the node sequence [a, b, c] meaning a → b → c → a. Self-loop → [a].
 */
import { RingBuffer } from "../ds/ring-buffer.js";
import type { DiGraph } from "./digraph.js";
import { cyclicSccs } from "./scc.js";

export interface ShortestCycleOptions {
  /** Max BFS sources tried (bounds O(V·(V+E)) on huge SCCs). Default: all. */
  maxSources?: number;
}

/**
 * Shortest directed cycle within `nodes` (default: whole graph). BFS from each source s,
 * restricted to the node set; the first edge u → s closes a cycle of length depth[u] + 1.
 */
export function shortestCycle(
  g: DiGraph,
  nodes?: Iterable<string>,
  opts: ShortestCycleOptions = {},
): string[] | null {
  const set = nodes ? new Set(nodes) : new Set(g.nodes());
  const maxSources = opts.maxSources ?? Number.POSITIVE_INFINITY;
  for (const s of set) if (g.hasEdge(s, s)) return [s];
  let best: string[] | null = null;
  let tried = 0;
  for (const s of set) {
    if (tried++ >= maxSources) break;
    const parent = new Map<string, string>();
    const depth = new Map<string, number>([[s, 0]]);
    const q = new RingBuffer<string>(64, { grow: true });
    q.push(s);
    let found: string | null = null;
    while (q.size > 0 && found === null) {
      const u = q.shift() as string;
      const du = depth.get(u) as number;
      if (best !== null && du + 1 >= best.length) break; // cannot improve
      for (const v of g.successorSet(u) ?? []) {
        if (!set.has(v)) continue;
        if (v === s) {
          found = u;
          break;
        }
        if (depth.has(v)) continue;
        depth.set(v, du + 1);
        parent.set(v, u);
        q.push(v);
      }
    }
    if (found !== null) {
      const path: string[] = [];
      for (let c: string | undefined = found; c !== undefined && c !== s; c = parent.get(c)) path.push(c);
      path.push(s);
      path.reverse();
      if (best === null || path.length < best.length) best = path;
      if (best.length === 2) return best; // no self-loops, so 2 is optimal
    }
  }
  return best;
}

/** One shortest example cycle per cyclic SCC. */
export function findCycles(g: DiGraph, opts: ShortestCycleOptions = {}): string[][] {
  const out: string[][] = [];
  for (const comp of cyclicSccs(g)) {
    const c = shortestCycle(g, comp, opts);
    if (c) out.push(c);
  }
  return out;
}
