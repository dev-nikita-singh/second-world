/**
 * Iterative BFS / DFS / reachability / bounded path enumeration —
 * docs/04-data-structures-and-algorithms.md §5.2, §5.3. No recursion (safe for 10^5+ node chains).
 */
import { RingBuffer } from "../ds/ring-buffer.js";
import type { DiGraph } from "./digraph.js";

export interface TraverseOptions {
  /** Follow edges backwards (predecessors). */
  reverse?: boolean;
  /** Stop expanding beyond this depth (start = 0). */
  maxDepth?: number;
}

export interface BfsResult {
  /** Visit order (starts included). */
  order: string[];
  depth: Map<string, number>;
  /** BFS-tree parent (undefined for starts). */
  parent: Map<string, string | undefined>;
}

function neighbours(g: DiGraph, id: string, reverse: boolean | undefined): Iterable<string> {
  return (reverse ? g.predecessorSet(id) : g.successorSet(id)) ?? [];
}

export function bfs(g: DiGraph, start: string | readonly string[], opts: TraverseOptions = {}): BfsResult {
  const starts = typeof start === "string" ? [start] : start;
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const order: string[] = [];
  const depth = new Map<string, number>();
  const parent = new Map<string, string | undefined>();
  const q = new RingBuffer<string>(64, { grow: true });
  for (const s of starts) {
    if (!g.hasNode(s) || depth.has(s)) continue;
    depth.set(s, 0);
    parent.set(s, undefined);
    q.push(s);
  }
  for (let u = q.shift(); u !== undefined; u = q.shift()) {
    order.push(u);
    const d = depth.get(u) as number;
    if (d >= maxDepth) continue;
    for (const v of neighbours(g, u, opts.reverse)) {
      if (depth.has(v)) continue;
      depth.set(v, d + 1);
      parent.set(v, u);
      q.push(v);
    }
  }
  return { order, depth, parent };
}

/** Set of nodes reachable from `start` (including the starts). */
export function reachable(
  g: DiGraph,
  start: string | readonly string[],
  opts: TraverseOptions = {},
): Set<string> {
  return new Set(bfs(g, start, opts).order);
}

/** Shortest (fewest edges) path from → to, or null. */
export function shortestPath(
  g: DiGraph,
  from: string,
  to: string,
  opts: { reverse?: boolean } = {},
): string[] | null {
  const { parent, depth } = bfs(g, from, opts);
  if (!depth.has(to)) return null;
  const path: string[] = [];
  for (let c: string | undefined = to; c !== undefined; c = parent.get(c)) path.push(c);
  return path.reverse();
}

export interface DfsResult {
  preorder: string[];
  postorder: string[];
}

/**
 * Iterative DFS with an explicit (node, iterator) stack. Visits from each start in order;
 * when `start` is omitted all nodes are used as roots (in insertion order).
 */
export function dfs(
  g: DiGraph,
  start?: string | readonly string[],
  opts: { reverse?: boolean } = {},
): DfsResult {
  const roots = start === undefined ? g.nodes() : typeof start === "string" ? [start] : start;
  const seen = new Set<string>();
  const preorder: string[] = [];
  const postorder: string[] = [];
  const stack: { id: string; it: Iterator<string> }[] = [];
  for (const r of roots) {
    if (!g.hasNode(r) || seen.has(r)) continue;
    seen.add(r);
    preorder.push(r);
    stack.push({ id: r, it: neighbours(g, r, opts.reverse)[Symbol.iterator]() });
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { id: string; it: Iterator<string> };
      const n = top.it.next();
      if (n.done) {
        stack.pop();
        postorder.push(top.id);
        continue;
      }
      const v = n.value;
      if (seen.has(v)) continue;
      seen.add(v);
      preorder.push(v);
      stack.push({ id: v, it: neighbours(g, v, opts.reverse)[Symbol.iterator]() });
    }
  }
  return { preorder, postorder };
}

export interface PathEnumOptions {
  /** Maximum number of paths returned (default 100). */
  maxPaths?: number;
  /** Maximum path length in edges (default 50). */
  maxDepth?: number;
}

/** Enumerate simple paths from → to (bounded), iteratively. */
export function enumeratePaths(g: DiGraph, from: string, to: string, opts: PathEnumOptions = {}): string[][] {
  const maxPaths = opts.maxPaths ?? 100;
  const maxDepth = opts.maxDepth ?? 50;
  const out: string[][] = [];
  if (!g.hasNode(from) || !g.hasNode(to) || maxPaths <= 0) return out;
  if (from === to) return [[from]];
  const path: string[] = [from];
  const onPath = new Set<string>([from]);
  const stack: Iterator<string>[] = [neighbours(g, from, false)[Symbol.iterator]()];
  while (stack.length > 0 && out.length < maxPaths) {
    const it = stack[stack.length - 1] as Iterator<string>;
    const n = it.next();
    if (n.done) {
      stack.pop();
      onPath.delete(path.pop() as string);
      continue;
    }
    const v = n.value;
    if (onPath.has(v)) continue;
    if (v === to) {
      out.push([...path, v]);
      continue;
    }
    if (path.length + 1 > maxDepth) continue; // extending via v needs ≥ path.length + 1 edges
    path.push(v);
    onPath.add(v);
    stack.push(neighbours(g, v, false)[Symbol.iterator]());
  }
  return out;
}
