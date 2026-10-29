/**
 * Impact set = reverse reachability — docs/04-data-structures-and-algorithms.md §5.2.
 * With edges meaning "from depends on to", the impact of a failing `id` is every node that can
 * reach it, i.e. a BFS over predecessors.
 */
import type { DiGraph } from "./digraph.js";
import { bfs } from "./traverse.js";

export interface ImpactEntry {
  id: string;
  /** Hops from the failing node. */
  depth: number;
}

/** Nodes transitively depending on `id` (excluding the start), nearest first. */
export function impactOf(
  g: DiGraph,
  id: string | readonly string[],
  opts: { maxDepth?: number } = {},
): string[] {
  return impactDetails(g, id, opts).map((e) => e.id);
}

export function impactDetails(
  g: DiGraph,
  id: string | readonly string[],
  opts: { maxDepth?: number } = {},
): ImpactEntry[] {
  const starts = new Set(typeof id === "string" ? [id] : id);
  const { order, depth } = bfs(g, [...starts], { reverse: true, ...opts });
  return order.filter((n) => !starts.has(n)).map((n) => ({ id: n, depth: depth.get(n) as number }));
}
