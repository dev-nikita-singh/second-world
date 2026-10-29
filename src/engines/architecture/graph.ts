/**
 * Graph build — docs/03-engines/architecture-inspector.md §1.4, §2; DSA §5.1.
 * Nodes: route, handler, service, repository, module, datastore, external, cache, queue.
 * Edges: calls, imports, reads, writes, publishes, consumes — each with evidence (file:line:col,
 * extractor id, confidence, snippet hash). Uses the shared DiGraph (forward + reverse adjacency).
 * Edge direction always means "from depends on to", so impact sets are reverse reachability.
 */
import { DiGraph, impactOf, sha256 } from "../../shared/index.js";
import { AUTH_RE_SOURCE } from "./rules/auth-pattern.js";
import type {
  ArchEdge,
  ComponentNode,
  EdgeEvidence,
  EdgeKind,
  FileFacts,
  NodeKind,
  RouteFact,
  RouteInfo,
  UnitFact,
  UseFact,
} from "./types.js";

export interface EdgeData {
  kind: EdgeKind;
  evidence: EdgeEvidence;
}

const MAX_EVIDENCE_PER_EDGE = 10;
const REPO_CLASS = /(^Db$|^DB$|Database$|Db$|DB$|Repo$|Repository$|Dao$|DAO$|Store$|DataSource$)/;
const AUTH_RE = new RegExp(AUTH_RE_SOURCE, "i");

export const moduleId = (file: string) => `module:${file}`;
export const unitNodeId = (unitId: string) => `fn:${unitId}`;
export const routeNodeId = (method: string, path: string) => `route:${method} ${path}`;

export interface ResolvedRoute extends RouteInfo {
  fact: RouteFact;
  file: string;
  public: boolean;
}

/** The inspected architecture as a queryable graph (spec §7: `r.data.graph.impactOf("datastore:postgres")`). */
export class ArchitectureGraph {
  readonly g = new DiGraph<ComponentNode, EdgeData>();

  addNode(n: ComponentNode): void {
    const existing = this.g.nodeData(n.id);
    if (!existing) this.g.addNode(n.id, n);
    else if (existing.kind === "service" && n.kind !== "service") this.g.addNode(n.id, { ...existing, ...n });
  }

  addEdge(from: string, to: string, kind: EdgeKind, ev: EdgeEvidence): void {
    if (from === to && kind !== "imports") return;
    const list = this.g.hasEdge(from, to) ? this.g.edgeData(from, to) : undefined;
    if (list && list.filter((d) => d.kind === kind).length >= MAX_EVIDENCE_PER_EDGE) return;
    if (
      list?.some(
        (d) =>
          d.kind === kind &&
          d.evidence.file === ev.file &&
          d.evidence.line === ev.line &&
          d.evidence.column === ev.column,
      )
    )
      return;
    this.g.addEdge(from, to, { kind, evidence: ev });
  }

  node(id: string): ComponentNode | undefined {
    return this.g.nodeData(id);
  }

  nodes(kind?: NodeKind | readonly NodeKind[]): ComponentNode[] {
    const ks = kind === undefined ? undefined : typeof kind === "string" ? [kind] : kind;
    const out: ComponentNode[] = [];
    for (const id of this.g.nodes()) {
      const n = this.g.nodeData(id);
      if (n && (!ks || ks.includes(n.kind))) out.push(n);
    }
    return out;
  }

  edges(kind?: EdgeKind | readonly EdgeKind[]): ArchEdge[] {
    const ks = kind === undefined ? undefined : typeof kind === "string" ? [kind] : kind;
    const out: ArchEdge[] = [];
    for (const e of this.g.edges()) {
      const byKind = new Map<EdgeKind, EdgeEvidence[]>();
      for (const d of e.data) {
        if (ks && !ks.includes(d.kind)) continue;
        let l = byKind.get(d.kind);
        if (!l) {
          l = [];
          byKind.set(d.kind, l);
        }
        l.push(d.evidence);
      }
      for (const [k, ev] of byKind) out.push({ from: e.from, to: e.to, kind: k, evidence: ev });
    }
    return out;
  }

  /** Components that (transitively) depend on `id` — "what breaks if X is down". */
  impactOf(id: string, opts: { kinds?: readonly NodeKind[]; maxDepth?: number } = {}): string[] {
    if (!this.g.hasNode(id)) return [];
    const ids = impactOf(this.g, id, opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth });
    return opts.kinds ? ids.filter((x) => opts.kinds?.includes(this.g.nodeData(x)?.kind as NodeKind)) : ids;
  }

  /** Nodes reachable from `id` (excluding it), BFS order. */
  dependenciesOf(id: string, opts: { kinds?: readonly NodeKind[] } = {}): string[] {
    if (!this.g.hasNode(id)) return [];
    const seen = new Set<string>([id]);
    const queue = [id];
    const out: string[] = [];
    for (let i = 0; i < queue.length; i++) {
      for (const s of this.g.successorSet(queue[i] as string) ?? []) {
        if (seen.has(s) || this.g.nodeData(s)?.kind === "module") continue;
        seen.add(s);
        queue.push(s);
        if (!opts.kinds || opts.kinds.includes(this.g.nodeData(s)?.kind as NodeKind)) out.push(s);
      }
    }
    return out;
  }

  fanIn(id: string): number {
    return this.g.inDegree(id);
  }

  fanOut(id: string): number {
    return this.g.outDegree(id);
  }

  toJSON(): { nodes: ComponentNode[]; edges: ArchEdge[] } {
    return { nodes: this.nodes(), edges: this.edges() };
  }

  toDot(opts: GraphViewOptions = {}): string {
    return toDot(this, opts);
  }

  toMermaid(opts: GraphViewOptions = {}): string {
    return toMermaid(this, opts);
  }
}

export interface GraphViewOptions {
  /** "components" (default, no module nodes), "modules" (import graph only), "all". */
  view?: "components" | "modules" | "all";
}

function viewFilter(
  graph: ArchitectureGraph,
  opts: GraphViewOptions,
): { nodes: ComponentNode[]; edges: ArchEdge[] } {
  const view = opts.view ?? "components";
  const keep = (n: ComponentNode) =>
    view === "all" ? true : view === "modules" ? n.kind === "module" : n.kind !== "module";
  const nodes = graph.nodes().filter(keep);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges().filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges };
}

const DOT_SHAPES: Record<NodeKind, string> = {
  route: "cds",
  handler: "box",
  service: "box",
  repository: "box3d",
  module: "note",
  client: "component",
  datastore: "cylinder",
  external: "doubleoctagon",
  cache: "cylinder",
  queue: "parallelogram",
};

const dotEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function toDot(graph: ArchitectureGraph, opts: GraphViewOptions = {}): string {
  const { nodes, edges } = viewFilter(graph, opts);
  const lines = ["digraph architecture {", "  rankdir=LR;", '  node [fontname="Helvetica", fontsize=10];'];
  for (const n of nodes) {
    lines.push(
      `  "${dotEsc(n.id)}" [label="${dotEsc(n.name)}", shape=${DOT_SHAPES[n.kind]}${n.heuristic ? ", style=dashed" : ""}];`,
    );
  }
  for (const e of edges) {
    const low = e.evidence.every((x) => x.heuristic);
    lines.push(
      `  "${dotEsc(e.from)}" -> "${dotEsc(e.to)}" [label="${e.kind}"${low ? ", style=dashed" : ""}];`,
    );
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

const mmEsc = (s: string) => s.replace(/"/g, "#quot;").replace(/[<>]/g, (c) => (c === "<" ? "#lt;" : "#gt;"));
const MM_SHAPES: Record<NodeKind, [string, string]> = {
  route: ["([", "])"],
  handler: ["[", "]"],
  service: ["[", "]"],
  repository: ["[[", "]]"],
  module: ["[/", "/]"],
  client: ["[", "]"],
  datastore: ["[(", ")]"],
  external: ["{{", "}}"],
  cache: ["[(", ")]"],
  queue: [">", "]"],
};

export function toMermaid(graph: ArchitectureGraph, opts: GraphViewOptions = {}): string {
  const { nodes, edges } = viewFilter(graph, opts);
  const idx = new Map<string, string>();
  nodes.forEach((n, i) => {
    idx.set(n.id, `n${i}`);
  });
  const lines = ["flowchart LR"];
  for (const n of nodes) {
    const [a, b] = MM_SHAPES[n.kind];
    lines.push(`  ${idx.get(n.id)}${a}"${mmEsc(n.name)}"${b}`);
  }
  for (const e of edges) {
    const arrow = e.evidence.every((x) => x.heuristic) ? "-.->" : "-->";
    lines.push(`  ${idx.get(e.from)} ${arrow}|${e.kind}| ${idx.get(e.to)}`);
  }
  return `${lines.join("\n")}\n`;
}

// --------------------------------------------------------------------------- build

function ownerParents(
  uses: readonly (UseFact & { file: string })[],
  owners: Set<string>,
): Map<string, { parent: string; prefix: string }[]> {
  const parents = new Map<string, { parent: string; prefix: string }[]>();
  const add = (child: string, parent: string, prefix: string) => {
    if (child === parent) return;
    let l = parents.get(child);
    if (!l) {
      l = [];
      parents.set(child, l);
    }
    if (!l.some((x) => x.parent === parent && x.prefix === prefix)) l.push({ parent, prefix });
  };
  for (const u of uses) {
    const prefix = u.prefix ?? "";
    if (u.targetOwner && owners.has(u.targetOwner)) add(u.targetOwner, u.owner, prefix);
    if (u.targetUnit) {
      for (const o of owners) if (o.startsWith(`${u.targetUnit}:`)) add(o, u.owner, prefix);
    }
  }
  return parents;
}

function joinPath(a: string, b: string): string {
  if (!a) return b || "/";
  const j = `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  return j.length > 1 ? j.replace(/\/$/, "") : j;
}

/** Effective prefixes of an owner: union over mount chains (iterative, bounded). */
function prefixesOf(owner: string, parents: Map<string, { parent: string; prefix: string }[]>): string[] {
  const out = new Set<string>();
  const stack: { o: string; suffix: string; depth: number; seen: Set<string> }[] = [
    { o: owner, suffix: "", depth: 0, seen: new Set([owner]) },
  ];
  while (stack.length > 0 && out.size < 10) {
    const { o, suffix, depth, seen } = stack.pop() as (typeof stack)[number];
    const ps = parents.get(o);
    if (!ps || ps.length === 0 || depth > 20) {
      out.add(suffix);
      continue;
    }
    for (const p of ps) {
      if (seen.has(p.parent)) {
        out.add(suffix);
        continue;
      }
      stack.push({
        o: p.parent,
        suffix: joinPath(p.prefix, suffix),
        depth: depth + 1,
        seen: new Set([...seen, p.parent]),
      });
    }
  }
  return [...out].sort();
}

function pathCovered(prefix: string | undefined, path: string): boolean {
  if (!prefix || prefix === "/" || prefix === "*" || prefix === "/*") return true;
  const p = prefix.replace(/\/\*$/, "").replace(/\/+$/, "");
  return path === p || path.startsWith(`${p}/`);
}

export interface BuildResult {
  graph: ArchitectureGraph;
  routes: ResolvedRoute[];
  units: Map<string, UnitFact & { file: string }>;
}

export function buildGraph(facts: readonly FileFacts[]): BuildResult {
  const graph = new ArchitectureGraph();
  const units = new Map<string, UnitFact & { file: string }>();
  for (const f of facts) for (const u of f.units) units.set(u.id, { ...u, file: f.file });

  // modules + imports
  const files = new Set(facts.map((f) => f.file));
  for (const f of facts)
    graph.addNode({ id: moduleId(f.file), kind: "module", name: f.file, file: f.file, line: 1 });
  for (const f of facts) {
    for (const i of f.imports) {
      if (!i.resolved || !files.has(i.resolved)) continue;
      graph.addEdge(moduleId(f.file), moduleId(i.resolved), "imports", {
        file: f.file,
        line: i.line,
        column: i.column,
        extractor: "core/imports",
        confidence: i.heuristic ? 0.5 : 1,
        ...(i.heuristic ? { heuristic: true } : {}),
      });
    }
  }

  // routes (prefix composition + auth coverage)
  const allUses = facts.flatMap((f) => f.uses.map((u) => ({ ...u, file: f.file })));
  const owners = new Set(facts.flatMap((f) => f.routes.map((r) => r.owner)));
  for (const u of allUses) owners.add(u.owner);
  const parents = ownerParents(allUses, owners);
  const usesByOwner = new Map<string, (UseFact & { file: string })[]>();
  for (const u of allUses) {
    let l = usesByOwner.get(u.owner);
    if (!l) {
      l = [];
      usesByOwner.set(u.owner, l);
    }
    l.push(u);
  }
  const routeOwners = new Set(facts.flatMap((f) => f.routes.map((r) => r.owner)));
  const isMount = (u: UseFact) =>
    (!!u.targetOwner && (routeOwners.has(u.targetOwner) || parents.has(u.targetOwner))) ||
    (!!u.targetUnit && [...routeOwners].some((o) => o.startsWith(`${u.targetUnit}:`)));
  const routes: ResolvedRoute[] = [];
  const handlerIds = new Set<string>();
  for (const f of facts) {
    for (const r of f.routes) {
      const prefixes = prefixesOf(r.owner, parents);
      for (const pre of prefixes) {
        const full = joinPath(pre, r.path);
        const mws = [...r.middlewares];
        let auth = r.auth;
        // same-owner uses registered before the route and covering its path
        for (const u of usesByOwner.get(r.owner) ?? []) {
          if (!u.auth) continue;
          if (u.file === f.file && u.line > r.line) continue;
          if (pathCovered(u.prefix, r.path)) {
            auth = true;
            mws.unshift(...u.middlewares);
          }
        }
        // inherited from mounting owners
        const chain: { o: string; sub: string }[] = [{ o: r.owner, sub: r.path }];
        for (let i = 0; i < chain.length && i < 50; i++) {
          const { o, sub } = chain[i] as { o: string; sub: string };
          for (const p of parents.get(o) ?? []) {
            const pathAtParent = joinPath(p.prefix, sub);
            for (const u of usesByOwner.get(p.parent) ?? []) {
              if (u.auth && !isMount(u) && pathCovered(u.prefix, pathAtParent)) {
                auth = true;
                mws.unshift(...u.middlewares);
              }
            }
            chain.push({ o: p.parent, sub: pathAtParent });
          }
        }
        // handler-level auth: the handler directly calls an auth-named function
        if (!auth && r.handler) {
          const hu = units.get(r.handler);
          if (hu?.calls.some((c) => AUTH_RE.test(c.target.slice(c.target.indexOf("#") + 1)))) auth = true;
        }
        const id = routeNodeId(r.method, full);
        const rr: ResolvedRoute = {
          id,
          framework: r.framework,
          method: r.method,
          path: full,
          middlewares: [...new Set(mws)],
          auth,
          file: f.file,
          line: r.line,
          fact: r,
          public: !!r.public,
        };
        if (r.handler) rr.handler = r.handler;
        routes.push(rr);
        graph.addNode({
          id,
          kind: "route",
          name: `${r.method} ${full}`,
          file: f.file,
          line: r.line,
          framework: r.framework,
          meta: { auth, middlewares: rr.middlewares },
        });
        if (r.handler) {
          handlerIds.add(r.handler);
          const hu = units.get(r.handler);
          graph.addNode({
            id: unitNodeId(r.handler),
            kind: "handler",
            name: hu?.name ?? r.handler.slice(r.handler.indexOf("#") + 1),
            file: f.file,
            line: hu?.line ?? r.line,
          });
          graph.addEdge(id, unitNodeId(r.handler), "calls", {
            file: f.file,
            line: r.line,
            column: r.column,
            extractor: r.extractor,
            confidence: r.confidence,
          });
        }
      }
    }
  }

  // units + calls
  const kindOfUnit = (u: UnitFact & { file: string }): NodeKind => {
    if (handlerIds.has(u.id) || u.kind === "handler" || u.kind === "consumer") return "handler";
    const cls = u.name.includes(".") ? (u.name.split(".")[0] as string) : "";
    return REPO_CLASS.test(cls) ? "repository" : "service";
  };
  const unitClients = new Set<string>();
  for (const f of facts) for (const c of f.clients) unitClients.add(c.unit);
  const ensureUnit = (id: string): string | undefined => {
    const u = units.get(id);
    if (!u) return undefined;
    if (u.kind === "module-init") {
      if (!unitClients.has(id)) return undefined;
      graph.addNode({
        id: unitNodeId(id),
        kind: "module",
        name: `${u.file} (top-level)`,
        file: u.file,
        line: 1,
      });
      return unitNodeId(id);
    }
    const kind = kindOfUnit(u);
    graph.addNode({
      id: unitNodeId(id),
      kind,
      name: u.name,
      file: u.file,
      line: u.line,
      ...(u.kind === "consumer" ? { meta: { consumer: true } } : {}),
    });
    return unitNodeId(id);
  };
  for (const u of units.values()) {
    if (
      u.calls.length === 0 &&
      !unitClients.has(u.id) &&
      !handlerIds.has(u.id) &&
      u.kind !== "handler" &&
      u.kind !== "consumer"
    )
      continue;
    const from = ensureUnit(u.id);
    if (!from) continue;
    for (const c of u.calls) {
      if (!units.has(c.target)) continue;
      const to = ensureUnit(c.target);
      if (!to) continue;
      graph.addEdge(from, to, "calls", {
        file: u.file,
        line: c.line,
        column: c.column,
        extractor: "core/calls",
        confidence: 0.9,
      });
    }
  }

  // clients → datastore / external / cache / queue
  for (const f of facts) {
    for (const c of f.clients) {
      const from = ensureUnit(c.unit) ?? moduleId(f.file);
      const kind: NodeKind = c.kind === "db" ? "datastore" : c.kind === "http" ? "external" : c.kind;
      const id = `${kind}:${c.target}`;
      graph.addNode({
        id,
        kind,
        name: c.target,
        library: c.library,
        ...(c.heuristicTarget ? { heuristic: true } : {}),
      });
      const ev: EdgeEvidence = {
        file: f.file,
        line: c.line,
        column: c.column,
        extractor: c.extractor,
        confidence: c.confidence,
        snippetHash: sha256(c.snippet).slice(0, 16),
      };
      if (c.confidence < 0.6 || c.heuristicTarget) ev.heuristic = true;
      graph.addEdge(from, id, c.op === "configures" ? "configures" : c.op, ev);
    }
  }
  return { graph, routes, units };
}
