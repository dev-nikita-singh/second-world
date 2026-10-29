/**
 * Model snapshot diff — docs/03-engines/system-model.md §3 ("Diffing snapshots"),
 * docs/03-engines/evidence-and-history.md ("Architecture snapshots: model graph diff between runs").
 */
import type { ModelData, ModelEdge, ModelNode } from "./types.js";

export interface ModelDiffOptions {
  /** Report confidence changes of at least this absolute amount (default 0.05). */
  confidenceDelta?: number;
  /** Report observed-metric changes of at least this relative amount (default 0.1 = 10%). */
  metricRelChange?: number;
}

export interface MetricChange {
  id: string;
  metric: string;
  before?: number;
  after?: number;
  /** (after − before) / before; undefined when a side is missing or before = 0. */
  relChange?: number;
}

export interface ModelDiff {
  schemaVersion: 1;
  addedNodes: ModelNode[];
  removedNodes: ModelNode[];
  addedEdges: ModelEdge[];
  removedEdges: ModelEdge[];
  changedKind: { id: string; before: string; after: string }[];
  changedConfidence: { id: string; type: "node" | "edge"; before: number; after: number }[];
  changedMetrics: MetricChange[];
  /** Nodes whose evidence sources changed (e.g. now observed in traces). */
  changedSources: { id: string; added: string[]; removed: string[] }[];
  summary: { added: number; removed: number; changed: number; unchanged: boolean };
}

const NODE_METRICS = ["rps", "p95Ms", "errorRate"] as const;
const EDGE_METRICS = ["callsPerRequest", "p95Ms", "errorRate"] as const;

function metricChanges(
  id: string,
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
  keys: readonly string[],
  rel: number,
  prefix: string,
): MetricChange[] {
  const out: MetricChange[] = [];
  for (const k of keys) {
    const x = typeof a?.[k] === "number" ? (a[k] as number) : undefined;
    const y = typeof b?.[k] === "number" ? (b[k] as number) : undefined;
    if (x === undefined && y === undefined) continue;
    if (x === undefined || y === undefined) {
      out.push({
        id,
        metric: `${prefix}${k}`,
        ...(x !== undefined ? { before: x } : {}),
        ...(y !== undefined ? { after: y } : {}),
      });
      continue;
    }
    if (x === y) continue;
    const r = x !== 0 ? (y - x) / Math.abs(x) : undefined;
    if (r === undefined ? Math.abs(y - x) > 1e-9 : Math.abs(r) >= rel)
      out.push({
        id,
        metric: `${prefix}${k}`,
        before: x,
        after: y,
        ...(r !== undefined ? { relChange: Math.round(r * 1000) / 1000 } : {}),
      });
  }
  return out;
}

const sources = (n: { evidence: { source: string }[] }): Set<string> =>
  new Set(n.evidence.map((e) => e.source));

export function diffModels(a: ModelData, b: ModelData, opts: ModelDiffOptions = {}): ModelDiff {
  if (a.schemaVersion !== b.schemaVersion)
    throw new Error(
      `Cannot diff model schema v${a.schemaVersion} with v${b.schemaVersion}; rebuild the older snapshot`,
    );
  const dc = opts.confidenceDelta ?? 0.05;
  const rel = opts.metricRelChange ?? 0.1;
  const an = new Map(a.nodes.map((n) => [n.id, n]));
  const bn = new Map(b.nodes.map((n) => [n.id, n]));
  const ae = new Map(a.edges.map((e) => [e.id, e]));
  const be = new Map(b.edges.map((e) => [e.id, e]));
  const d: ModelDiff = {
    schemaVersion: 1,
    addedNodes: b.nodes.filter((n) => !an.has(n.id)),
    removedNodes: a.nodes.filter((n) => !bn.has(n.id)),
    addedEdges: b.edges.filter((e) => !ae.has(e.id)),
    removedEdges: a.edges.filter((e) => !be.has(e.id)),
    changedKind: [],
    changedConfidence: [],
    changedMetrics: [],
    changedSources: [],
    summary: { added: 0, removed: 0, changed: 0, unchanged: true },
  };
  for (const [id, x] of an) {
    const y = bn.get(id);
    if (!y) continue;
    if (x.kind !== y.kind) d.changedKind.push({ id, before: x.kind, after: y.kind });
    if (Math.abs(x.confidence - y.confidence) >= dc)
      d.changedConfidence.push({ id, type: "node", before: x.confidence, after: y.confidence });
    d.changedMetrics.push(
      ...metricChanges(
        id,
        x.observed as Record<string, unknown> | undefined,
        y.observed as Record<string, unknown> | undefined,
        NODE_METRICS,
        rel,
        "",
      ),
    );
    const sx = sources(x);
    const sy = sources(y);
    const added = [...sy].filter((s) => !sx.has(s)).sort();
    const removed = [...sx].filter((s) => !sy.has(s)).sort();
    if (added.length || removed.length) d.changedSources.push({ id, added, removed });
  }
  for (const [id, x] of ae) {
    const y = be.get(id);
    if (!y) continue;
    if (Math.abs(x.confidence - y.confidence) >= dc)
      d.changedConfidence.push({ id, type: "edge", before: x.confidence, after: y.confidence });
    d.changedMetrics.push(
      ...metricChanges(
        id,
        x.observed as Record<string, unknown> | undefined,
        y.observed as Record<string, unknown> | undefined,
        EDGE_METRICS,
        rel,
        "",
      ),
    );
  }
  const byId = (p: { id: string }, q: { id: string }) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0);
  d.addedNodes.sort(byId);
  d.removedNodes.sort(byId);
  d.addedEdges.sort(byId);
  d.removedEdges.sort(byId);
  d.summary.added = d.addedNodes.length + d.addedEdges.length;
  d.summary.removed = d.removedNodes.length + d.removedEdges.length;
  d.summary.changed =
    d.changedKind.length + d.changedConfidence.length + d.changedMetrics.length + d.changedSources.length;
  d.summary.unchanged = d.summary.added + d.summary.removed + d.summary.changed === 0;
  return d;
}
