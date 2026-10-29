/**
 * Queryable model graph — docs/03-engines/system-model.md §3 (impact queries), DSA §5.2 (BFS, k-hop).
 * Edge a → b means "a depends on b" (same convention as the Architecture Inspector).
 */
import { DiGraph } from "../../shared/graph/digraph.js";
import { impactDetails } from "../../shared/graph/impact.js";
import { bfs } from "../../shared/graph/traverse.js";
import { modelToDot, modelToMermaid, toCanonicalJson } from "./export.js";
import { normalizeName } from "./similarity.js";
import type { ModelData, ModelEdge, ModelNode } from "./types.js";

export interface Neighbourhood {
  center: string;
  nodes: ModelNode[];
  edges: ModelEdge[];
  /** Hop distance per node id (undirected). */
  depth: Record<string, number>;
}

export class ModelGraph {
  readonly g = new DiGraph<ModelNode, ModelEdge>();
  private readonly byId = new Map<string, ModelNode>();
  private readonly byName = new Map<string, string[]>();

  constructor(readonly model: ModelData) {
    for (const n of model.nodes) {
      this.g.addNode(n.id, n);
      this.byId.set(n.id, n);
      for (const nm of n.names) {
        const k = normalizeName(nm);
        const l = this.byName.get(k) ?? [];
        if (!l.includes(n.id)) l.push(n.id);
        this.byName.set(k, l);
      }
    }
    for (const e of model.edges) this.g.addEdge(e.from, e.to, e);
  }

  node(id: string): ModelNode | undefined {
    return this.byId.get(id);
  }

  /** Resolve an id, name or alias (normalised) to node ids. */
  find(idOrName: string): ModelNode[] {
    const exact = this.byId.get(idOrName);
    if (exact) return [exact];
    return (this.byName.get(normalizeName(idOrName)) ?? []).map((id) => this.byId.get(id) as ModelNode);
  }

  private ids(idOrName: string): string[] {
    return this.find(idOrName).map((n) => n.id);
  }

  /** Everything that (transitively) depends on the node, nearest first. */
  impactOf(idOrName: string, opts: { maxDepth?: number } = {}): { id: string; depth: number }[] {
    const ids = this.ids(idOrName);
    if (ids.length === 0) return [];
    return impactDetails(this.g, ids, opts).map((x) => ({ id: x.id, depth: x.depth }));
  }

  /**
   * Routes whose requests can reach the node. `approximate: true` adds routes of services that reach
   * the node only through service-level edges (config/static/experiment evidence without route detail).
   */
  routesReaching(idOrName: string, opts: { approximate?: boolean } = {}): string[] {
    const impact = this.impactOf(idOrName);
    const routes = new Set<string>();
    const services = new Set<string>();
    for (const { id } of impact) {
      const n = this.byId.get(id);
      if (n?.kind === "route") routes.add(id);
      else if (n?.kind === "service") services.add(id);
    }
    if (opts.approximate)
      for (const n of this.model.nodes)
        if (n.kind === "route" && n.service && services.has(n.service)) routes.add(n.id);
    return [...routes].sort();
  }

  /** k-hop neighbourhood in both directions (for the AI evidence packer). */
  neighbourhood(idOrName: string, k = 1): Neighbourhood | undefined {
    const center = this.ids(idOrName)[0];
    if (!center) return undefined;
    // Undirected BFS (callers and callees) up to k hops.
    const depth: Record<string, number> = { [center]: 0 };
    const queue = [center];
    for (let qi = 0; qi < queue.length; qi++) {
      const id = queue[qi] as string;
      const d = depth[id] as number;
      if (d >= k) continue;
      for (const nb of [...(this.g.successorSet(id) ?? []), ...(this.g.predecessorSet(id) ?? [])]) {
        if (depth[nb] !== undefined) continue;
        depth[nb] = d + 1;
        queue.push(nb);
      }
    }
    const keep = new Set(Object.keys(depth));
    return {
      center,
      nodes: this.model.nodes.filter((n) => keep.has(n.id)),
      edges: this.model.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
      depth,
    };
  }

  dependenciesOf(idOrName: string): string[] {
    const ids = this.ids(idOrName);
    if (ids.length === 0) return [];
    return bfs(this.g, ids).order.filter((x) => !ids.includes(x));
  }

  toDot(opts: { title?: string } = {}): string {
    return modelToDot(this.model, opts);
  }
  toMermaid(): string {
    return modelToMermaid(this.model);
  }
  toJSON(): ModelData {
    return JSON.parse(toCanonicalJson(this.model)) as ModelData;
  }
}

/** Attach a non-enumerable `graph` (not serialised by JSON.stringify). */
export function withGraph<T extends ModelData>(model: T): T & { readonly graph: ModelGraph } {
  let cached: ModelGraph | undefined;
  Object.defineProperty(model, "graph", {
    enumerable: false,
    configurable: true,
    get: () => {
      cached ??= new ModelGraph(model);
      return cached;
    },
  });
  return model as T & { readonly graph: ModelGraph };
}
