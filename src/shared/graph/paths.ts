/**
 * DAG longest path / critical path by DP over a topological order —
 * docs/04-data-structures-and-algorithms.md §5.6.
 * dist[v] = nodeWeight(v) + max over predecessors u of (dist[u] + edgeWeight(u, v)).
 * Defaults: nodeWeight 0, edgeWeight 1 → length counts edges. Throws CycleError on cycles.
 */
import type { DiGraph } from "./digraph.js";
import { topoSort } from "./toposort.js";

export interface LongestPathOptions<E> {
  nodeWeight?: (id: string) => number;
  edgeWeight?: (from: string, to: string, data: E[]) => number;
}

export interface LongestPathResult {
  length: number;
  path: string[];
  /** Longest path length ending at each node. */
  dist: Map<string, number>;
}

export function longestPath<N, E>(g: DiGraph<N, E>, opts: LongestPathOptions<E> = {}): LongestPathResult {
  const nodeW = opts.nodeWeight ?? (() => 0);
  const edgeW = opts.edgeWeight ?? (() => 1);
  const order = topoSort(g);
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  let bestNode: string | undefined;
  let best = Number.NEGATIVE_INFINITY;
  for (const v of order) {
    let d = 0;
    let p: string | undefined;
    for (const u of g.predecessorSet(v) ?? []) {
      const cand = (dist.get(u) as number) + edgeW(u, v, g.edgeData(u, v));
      if (p === undefined || cand > d) {
        d = cand;
        p = u;
      }
    }
    if (p === undefined) d = 0;
    else prev.set(v, p);
    d += nodeW(v);
    dist.set(v, d);
    if (d > best) {
      best = d;
      bestNode = v;
    }
  }
  const path: string[] = [];
  for (let c = bestNode; c !== undefined; c = prev.get(c)) path.push(c);
  path.reverse();
  return { length: bestNode === undefined ? 0 : best, path, dist };
}
