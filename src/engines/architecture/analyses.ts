/**
 * Graph analyses — docs/03-engines/architecture-inspector.md §1.5, §3; DSA §5.2–5.6.
 * Module cycles (Tarjan SCC + shortest example cycle via BFS), fan-in/fan-out hubs, route →
 * datastore/external reachability, impact sets of dependencies, deepest call chain on the
 * condensation DAG (topological DP). All iterative via src/shared/graph.
 */
import { condensation, cyclicSccs, DiGraph, longestPath, shortestCycle } from "../../shared/index.js";
import { type ArchitectureGraph, moduleId } from "./graph.js";
import type { CycleInfo, FileFacts, NodeKind, NodeMetric } from "./types.js";

export const DEPENDENCY_KINDS: readonly NodeKind[] = ["datastore", "external", "cache", "queue"];

/** Runtime module graph: static, value (non type-only), non-dynamic imports between project files. */
export function moduleImportGraph(
  facts: readonly FileFacts[],
): DiGraph<undefined, { line: number; column: number }> {
  const g = new DiGraph<undefined, { line: number; column: number }>();
  const files = new Set(facts.map((f) => f.file));
  for (const f of facts) g.addNode(f.file);
  for (const f of facts) {
    for (const i of f.imports) {
      if (!i.resolved || i.typeOnly || i.dynamic || !files.has(i.resolved)) continue;
      if (!g.hasEdge(f.file, i.resolved)) g.addEdge(f.file, i.resolved, { line: i.line, column: i.column });
    }
  }
  return g;
}

export function findModuleCycles(facts: readonly FileFacts[]): CycleInfo[] {
  const g = moduleImportGraph(facts);
  const out: CycleInfo[] = [];
  for (const comp of cyclicSccs(g)) {
    const members = [...comp].sort();
    let example = shortestCycle(g, comp, { maxSources: 200 }) ?? members;
    // rotate so the cycle starts at its lexicographically smallest file (stable output)
    const min = [...example].sort()[0] as string;
    const k = example.indexOf(min);
    example = [...example.slice(k), ...example.slice(0, k)];
    out.push({ members, example });
  }
  return out.sort((a, b) => (a.example[0] as string).localeCompare(b.example[0] as string));
}

/** Location of the import statement `from` → `to` (first one). */
export function importLocation(
  facts: readonly FileFacts[],
  from: string,
  to: string,
): { line: number; column: number } | undefined {
  const f = facts.find((x) => x.file === from);
  const i = f?.imports.find((x) => x.resolved === to && !x.typeOnly && !x.dynamic);
  return i ? { line: i.line, column: i.column } : undefined;
}

export function hubs(graph: ArchitectureGraph, top = 10): NodeMetric[] {
  const out: NodeMetric[] = [];
  for (const n of graph.nodes()) {
    if (n.kind === "module") continue;
    const fanIn = countNonModule(graph, graph.g.predecessorSet(n.id));
    const fanOut = countNonModule(graph, graph.g.successorSet(n.id));
    if (fanIn > 0 && fanOut > 0) out.push({ id: n.id, fanIn, fanOut });
  }
  return out
    .sort((a, b) => b.fanIn * b.fanOut - a.fanIn * a.fanOut || a.id.localeCompare(b.id))
    .slice(0, top);
}

function countNonModule(graph: ArchitectureGraph, s: ReadonlySet<string> | undefined): number {
  let c = 0;
  for (const x of s ?? []) if (graph.node(x)?.kind !== "module") c++;
  return c;
}

/** route id → reachable dependency node ids. */
export function routeReachability(graph: ArchitectureGraph): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of graph.nodes("route"))
    out[r.id] = graph.dependenciesOf(r.id, { kinds: DEPENDENCY_KINDS }).sort();
  return out;
}

/** dependency id → routes that (transitively) depend on it. */
export function dependencyImpact(graph: ArchitectureGraph): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const d of graph.nodes(DEPENDENCY_KINDS))
    out[d.id] = graph.impactOf(d.id, { kinds: ["route"] }).sort();
  return out;
}

/** Longest chain over call/data edges (component view) on the condensation DAG. */
export function deepestChain(graph: ArchitectureGraph): { length: number; path: string[] } {
  const g = new DiGraph();
  for (const n of graph.nodes()) if (n.kind !== "module") g.addNode(n.id);
  for (const e of graph.g.edges()) {
    if (!g.hasNode(e.from) || !g.hasNode(e.to)) continue;
    if (e.data.some((d) => d.kind !== "imports")) g.addEdge(e.from, e.to);
  }
  if (g.nodeCount === 0) return { length: 0, path: [] };
  const c = condensation(g);
  const lp = longestPath(c.dag);
  const path = lp.path.map((ci) => {
    const members = c.components[Number(ci)] ?? [];
    return [...members].sort()[0] as string;
  });
  return { length: lp.length, path };
}

export { moduleId };
