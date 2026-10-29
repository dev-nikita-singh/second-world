/**
 * Kahn's topological sort and parallel levels — docs/04-data-structures-and-algorithms.md §5.5.
 * Deterministic: ties are broken by node insertion order. A leftover non-zero in-degree means a
 * cycle; `CycleError.cycle` carries one shortest example cycle ([a, b, c] = a → b → c → a).
 */
import { RingBuffer } from "../ds/ring-buffer.js";
import { shortestCycle } from "./cycles.js";
import type { DiGraph } from "./digraph.js";
import { cyclicSccs } from "./scc.js";

export class CycleError extends Error {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    const shown = cycle.length > 0 ? [...cycle, cycle[0]].join(" -> ") : "(unknown)";
    super(`Graph contains a cycle: ${shown}`);
    this.name = "CycleError";
    this.cycle = cycle;
  }
}

function cycleOf(g: DiGraph, remaining: string[]): string[] {
  const sub = g.subgraph(remaining);
  const comp = cyclicSccs(sub)[0];
  return (comp && shortestCycle(sub, comp)) ?? [];
}

/** Topological order (every edge u → v has u before v). Throws CycleError. */
export function topoSort(g: DiGraph): string[] {
  const { ids, offsets, targets } = g.toCsr();
  const V = ids.length;
  const indeg = new Int32Array(V);
  for (let k = 0; k < targets.length; k++) {
    const t = targets[k] as number;
    indeg[t] = (indeg[t] as number) + 1;
  }
  const q = new RingBuffer<number>(64, { grow: true });
  for (let i = 0; i < V; i++) if (indeg[i] === 0) q.push(i);
  const order: string[] = [];
  while (q.size > 0) {
    const u = q.shift() as number;
    order.push(ids[u] as string);
    for (let e = offsets[u] as number; e < (offsets[u + 1] as number); e++) {
      const v = targets[e] as number;
      indeg[v] = (indeg[v] as number) - 1;
      if (indeg[v] === 0) q.push(v);
    }
  }
  if (order.length !== V) {
    const remaining: string[] = [];
    for (let i = 0; i < V; i++) if ((indeg[i] as number) > 0) remaining.push(ids[i] as string);
    throw new CycleError(cycleOf(g, remaining));
  }
  return order;
}

/**
 * Parallel levels: level 0 = nodes without predecessors, level k = nodes whose predecessors are
 * all in levels < k. Nodes within a level can run concurrently. Throws CycleError.
 */
export function topoLevels(g: DiGraph): string[][] {
  const { ids, offsets, targets } = g.toCsr();
  const V = ids.length;
  const indeg = new Int32Array(V);
  for (let k = 0; k < targets.length; k++) {
    const t = targets[k] as number;
    indeg[t] = (indeg[t] as number) + 1;
  }
  let frontier: number[] = [];
  for (let i = 0; i < V; i++) if (indeg[i] === 0) frontier.push(i);
  const levels: string[][] = [];
  let seen = 0;
  while (frontier.length > 0) {
    levels.push(frontier.map((i) => ids[i] as string));
    seen += frontier.length;
    const next: number[] = [];
    for (const u of frontier) {
      for (let e = offsets[u] as number; e < (offsets[u + 1] as number); e++) {
        const v = targets[e] as number;
        indeg[v] = (indeg[v] as number) - 1;
        if (indeg[v] === 0) next.push(v);
      }
    }
    next.sort((a, b) => a - b);
    frontier = next;
  }
  if (seen !== V) {
    const remaining: string[] = [];
    for (let i = 0; i < V; i++) if ((indeg[i] as number) > 0) remaining.push(ids[i] as string);
    throw new CycleError(cycleOf(g, remaining));
  }
  return levels;
}

/** True if the graph has no directed cycle. */
export function isDag(g: DiGraph): boolean {
  try {
    topoSort(g);
    return true;
  } catch (e) {
    if (e instanceof CycleError) return false;
    throw e;
  }
}
