/**
 * Architecture Inspector result → observations (static evidence, docs/03-engines/system-model.md §1:
 * resolved symbol 0.75, naming heuristic 0.5).
 *
 * "components" detail: routes + infrastructure nodes (datastore/external/cache/queue), with
 * route → dependency edges found by walking the call graph from each route (internal functions are
 * collapsed), plus primary-service → dependency edges. "full" detail additionally keeps handlers
 * and internal functions (kind handler/module) with their direct edges.
 */
import type { ArchitectureData } from "../../architecture/index.js";
import { DEFAULT_CONFIDENCE } from "../confidence.js";
import { normalizeName } from "../similarity.js";
import type { ModelEdgeKind, ModelEvidence, ModelNodeKind } from "../types.js";
import {
  emptySet,
  type NodeObservation,
  normHostPort,
  normRoutePath,
  type ObservationSet,
  PRIMARY_KEY,
} from "./observation.js";

type ArchLike = Pick<ArchitectureData, "components" | "edges" | "routes"> & { project?: { root?: string } };

const INFRA = new Set(["datastore", "external", "cache", "queue"]);
const MAX_EVIDENCE = 8;

function staticEvidence(
  ev: { file: string; line: number; extractor: string; confidence: number; heuristic?: boolean },
  detail: string,
): ModelEvidence {
  const heuristic = ev.heuristic === true || ev.confidence < 0.6;
  return {
    source: heuristic ? "static-heuristic" : "static",
    confidence: heuristic ? DEFAULT_CONFIDENCE["static-heuristic"] : DEFAULT_CONFIDENCE.static,
    origin: ev.file,
    line: ev.line,
    detail: `${detail} (${ev.extractor})`,
  };
}

function edgeKind(k: string): ModelEdgeKind {
  if (k === "reads" || k === "writes" || k === "publishes" || k === "consumes" || k === "calls") return k;
  return "depends";
}

/** Tokens for an infra component name: `host:port`, hostnames, env-var stems. */
function infraTokens(name: string): Pick<NodeObservation, "hosts" | "serviceNames" | "envStems"> {
  const out: Pick<NodeObservation, "hosts" | "serviceNames" | "envStems"> = {};
  const m = /^([A-Za-z0-9.-]+):(\d+)$/.exec(name);
  if (m) {
    const hp = normHostPort(m[1] as string, m[2] as string);
    if (hp) out.hosts = [hp];
    if (!/^\d/.test(m[1] as string) && m[1] !== "localhost")
      out.serviceNames = [(m[1] as string).toLowerCase()];
  } else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name) && !/^\d/.test(name)) {
    out.serviceNames = [name.toLowerCase()];
  }
  const stem = normalizeName(name.split(":")[0] ?? name);
  if (stem) out.envStems = [stem];
  return out;
}

export function fromArchitecture(
  data: ArchLike,
  opts: { detail?: "components" | "full" } = {},
): ObservationSet {
  const set = emptySet();
  set.coverage.static = true;
  const full = opts.detail === "full";
  const comp = new Map(data.components.map((c) => [c.id, c]));
  const key = (id: string) => `arch:${id}`;
  // Infra nodes: evidence from incoming edges.
  const incoming = new Map<string, ModelEvidence[]>();
  for (const e of data.edges) {
    if (!INFRA.has(comp.get(e.to)?.kind ?? "")) continue;
    let l = incoming.get(e.to);
    if (!l) {
      l = [];
      incoming.set(e.to, l);
    }
    for (const ev of e.evidence) if (l.length < MAX_EVIDENCE) l.push(staticEvidence(ev, `${e.kind} ${e.to}`));
  }
  for (const c of data.components) {
    if (!INFRA.has(c.kind)) continue;
    const ev = incoming.get(c.id) ?? [];
    if (ev.length === 0)
      ev.push({
        source: c.heuristic ? "static-heuristic" : "static",
        confidence: c.heuristic ? DEFAULT_CONFIDENCE["static-heuristic"] : DEFAULT_CONFIDENCE.static,
        origin: c.file ?? "(architecture)",
        detail: `${c.kind} ${c.name}${c.library ? ` via ${c.library}` : ""}`,
      });
    set.nodes.push({
      key: key(c.id),
      kind: c.kind as ModelNodeKind,
      name: c.name,
      evidence: ev,
      ...infraTokens(c.name),
    });
  }
  // Routes (owned by the primary service).
  for (const r of data.routes) {
    const path = normRoutePath(r.path);
    set.nodes.push({
      key: key(r.id),
      kind: "route",
      name: `${r.method} ${path}`,
      route: { method: r.method.toUpperCase(), path, serviceKey: PRIMARY_KEY },
      evidence: [
        {
          source: "static",
          confidence: DEFAULT_CONFIDENCE.static,
          origin: r.file,
          line: r.line,
          detail: `${r.framework} route ${r.method} ${r.path}${r.auth ? " (auth)" : ""}`,
        },
      ],
      fuzzy: false,
    });
  }
  // Route → dependency edges by walking calls from each route (iterative BFS).
  const out = new Map<string, typeof data.edges>();
  for (const e of data.edges) {
    if (e.kind === "imports") continue;
    let l = out.get(e.from);
    if (!l) {
      l = [];
      out.set(e.from, l);
    }
    l.push(e);
  }
  const svcEdges = new Map<string, { to: string; kind: ModelEdgeKind; ev: ModelEvidence[] }>();
  for (const r of data.routes) {
    const seen = new Set<string>([r.id]);
    const queue = [r.id];
    const found = new Map<string, { kind: ModelEdgeKind; ev: ModelEvidence[] }>();
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi] as string;
      for (const e of out.get(cur) ?? []) {
        const tk = comp.get(e.to)?.kind ?? "";
        if (INFRA.has(tk)) {
          const kind = edgeKind(e.kind);
          const k = `${e.to}\u0000${kind}`;
          let f = found.get(k);
          if (!f) {
            f = { kind, ev: [] };
            found.set(k, f);
          }
          for (const ev of e.evidence)
            if (f.ev.length < MAX_EVIDENCE) f.ev.push(staticEvidence(ev, `${e.kind} ${e.to}`));
          continue;
        }
        if (!seen.has(e.to)) {
          seen.add(e.to);
          queue.push(e.to);
        }
      }
    }
    for (const [k, f] of found) {
      const to = k.split("\u0000")[0] as string;
      set.edges.push({ from: key(r.id), to: key(to), kind: f.kind, evidence: f.ev });
      const sk = `${to}\u0000${f.kind}`;
      let s = svcEdges.get(sk);
      if (!s) {
        s = { to, kind: f.kind, ev: [] };
        svcEdges.set(sk, s);
      }
      for (const ev of f.ev) {
        if (s.ev.length >= MAX_EVIDENCE) break;
        if (!s.ev.some((x) => x.origin === ev.origin && x.line === ev.line)) s.ev.push(ev);
      }
    }
  }
  for (const s of svcEdges.values())
    set.edges.push({ from: PRIMARY_KEY, to: key(s.to), kind: s.kind, evidence: s.ev });
  // Full detail: handlers + internal functions as handler/module nodes with direct edges.
  if (full) {
    for (const c of data.components) {
      if (c.kind === "route" || c.kind === "module" || INFRA.has(c.kind)) continue;
      set.nodes.push({
        key: key(c.id),
        kind: c.kind === "handler" ? "handler" : "module",
        name: c.name,
        serviceKey: PRIMARY_KEY,
        evidence: [
          {
            source: c.heuristic ? "static-heuristic" : "static",
            confidence: c.heuristic ? DEFAULT_CONFIDENCE["static-heuristic"] : DEFAULT_CONFIDENCE.static,
            origin: c.file ?? "(architecture)",
            ...(c.line !== undefined ? { line: c.line } : {}),
            detail: `${c.kind} ${c.name}`,
          },
        ],
        fuzzy: false,
      });
    }
    for (const e of data.edges) {
      if (e.kind === "imports") continue;
      const fk = comp.get(e.from)?.kind;
      const tk = comp.get(e.to)?.kind;
      if (!fk || !tk || fk === "module" || tk === "module") continue;
      if (fk === "route" && INFRA.has(tk)) continue;
      set.edges.push({
        from: key(e.from),
        to: key(e.to),
        kind: edgeKind(e.kind),
        evidence: e.evidence.slice(0, MAX_EVIDENCE).map((ev) => staticEvidence(ev, `${e.kind} ${e.to}`)),
      });
    }
  }
  return set;
}
