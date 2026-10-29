/**
 * System Model rendering (docs/03-engines/system-model.md; CONTRACTS.md "sw-model" reporting
 * notes). Coverage banner first (verbatim), then nodes, edges, merges (proposed = to verify),
 * critical path per route, failure modes, the Mermaid source (md/html only) and any model
 * limitations not already on the EngineResult. Low-confidence (< 60%) nodes/edges are flagged.
 * ModelDiff (`sw model diff`) renders as added / removed / changed tables.
 */
import type { Limitation } from "../../core/evidence/schemas.js";
import type { ModelDiff } from "../model/diff.js";
import { modelToMermaid } from "../model/export.js";
import type { ModelData, ModelEdge, ModelEvidence, ModelNode } from "../model/types.js";
import { type Block, type CellLike, fmtVal } from "./blocks.js";
import { fmtMs, fmtPct } from "./model.js";

export function isModelData(d: unknown): d is ModelData {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    o.schemaVersion === 1 &&
    Array.isArray(o.nodes) &&
    Array.isArray(o.edges) &&
    Array.isArray(o.merges) &&
    typeof o.coverage === "object" &&
    o.coverage !== null &&
    typeof (o.coverage as { banner?: unknown }).banner === "string"
  );
}

export function isModelDiff(d: unknown): d is ModelDiff {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    Array.isArray(o.addedNodes) &&
    Array.isArray(o.removedNodes) &&
    Array.isArray(o.addedEdges) &&
    Array.isArray(o.removedEdges) &&
    Array.isArray(o.changedConfidence) &&
    typeof o.summary === "object" &&
    o.summary !== null
  );
}

const MAX_ROWS = 200;
const LOW_CONFIDENCE = 0.6;
const LOW_NOTE = "low confidence, unconfirmed";

const sourcesOf = (ev: readonly ModelEvidence[]): string =>
  [...new Set(ev.map((e) => e.source))].sort().join(", ");

function nameCell(n: ModelNode): CellLike {
  const [first, ...aliases] = n.names;
  const text = `${first ?? n.id}${aliases.length > 0 ? ` (aka ${aliases.join(", ")})` : ""}`;
  return n.confidence < LOW_CONFIDENCE ? { text, tone: "warn" } : text;
}

function observedNode(n: ModelNode): string {
  const o = n.observed;
  if (!o) return "-";
  const parts: string[] = [];
  if (o.p95Ms !== undefined) parts.push(`p95 ${fmtMs(o.p95Ms)}`);
  if (o.rps !== undefined) parts.push(`${fmtVal(o.rps)}/s`);
  if (o.errorRate !== undefined) parts.push(`err ${fmtPct(o.errorRate)}`);
  return parts.length > 0 ? `${parts.join(", ")} [${o.source}]` : "-";
}

function nodeNote(n: ModelNode): CellLike {
  const notes: string[] = [];
  if (n.confidence < LOW_CONFIDENCE) notes.push(LOW_NOTE);
  if (n.proposedMerge) notes.push("? proposed merge, verify");
  return notes.length > 0 ? { text: notes.join("; "), tone: "warn" } : "";
}

function capped<T>(rows: readonly T[], what: string, b: Block[]): readonly T[] {
  if (rows.length > MAX_ROWS)
    b.push({
      kind: "text",
      tone: "muted",
      text: `Showing the first ${MAX_ROWS} of ${rows.length} ${what}; the JSON report has all.`,
    });
  return rows.slice(0, MAX_ROWS);
}

export function modelBlocks(d: ModelData, resultLimitations: readonly Limitation[] = []): Block[] {
  const b: Block[] = [];
  b.push({ kind: "quote", title: "Coverage", text: d.coverage.banner, ascii: d.coverage.bannerAscii });

  const name = new Map(d.nodes.map((n) => [n.id, n.names[0] ?? n.id]));
  const nm = (id: string): string => name.get(id) ?? id;
  const st = d.stats;
  const kv: [string, CellLike][] = [
    ["built at", d.builtAt],
    ...(d.primaryService ? ([["primary service", nm(d.primaryService)]] as [string, CellLike][]) : []),
    ["nodes / edges", `${st.nodes} / ${st.edges}`],
    ["merges", `${st.merges} (${st.proposedMerges} proposed)`],
    [
      "runtime observed",
      d.coverage.runtimeObserved
        ? { text: "yes", tone: "good" }
        : { text: "no (structure only)", tone: "warn" },
    ],
  ];
  if (d.traces) {
    const t = d.traces;
    kv.push([
      "traces",
      `${t.traces} traces, ${t.spans} spans, services ${t.services.join(", ") || "-"}${t.orphanSpans > 0 ? `, ${t.orphanSpans} orphan spans` : ""}${t.droppedSpans > 0 ? `, ${t.droppedSpans} dropped` : ""}`,
    ]);
  }
  b.push({ kind: "kv", items: kv });

  // ---- nodes
  const nodes = capped(d.nodes, "nodes", b);
  b.push({
    kind: "table",
    title: `Nodes (${d.nodes.length})`,
    head: ["name", "kind", "confidence", "evidence sources", "observed", "note"],
    align: ["l", "l", "r", "l", "l", "l"],
    rows: nodes.map((n) => [
      nameCell(n),
      n.kind,
      fmtPct(n.confidence),
      sourcesOf(n.evidence),
      observedNode(n),
      nodeNote(n),
    ]),
  });

  // ---- edges
  if (d.edges.length > 0) {
    const edges = capped(d.edges, "edges", b);
    b.push({
      kind: "table",
      title: `Edges (${d.edges.length})`,
      head: ["from → to", "kind", "confidence", "evidence sources", "calls/request", "p95", "note"],
      align: ["l", "l", "r", "l", "r", "r", "l"],
      rows: edges.map((e: ModelEdge) => [
        e.confidence < LOW_CONFIDENCE
          ? { text: `${nm(e.from)} → ${nm(e.to)}`, tone: "warn" }
          : `${nm(e.from)} → ${nm(e.to)}`,
        e.kind,
        fmtPct(e.confidence),
        sourcesOf(e.evidence),
        e.observed?.callsPerRequest !== undefined ? fmtVal(e.observed.callsPerRequest) : "-",
        e.observed?.p95Ms !== undefined ? fmtMs(e.observed.p95Ms) : "-",
        e.confidence < LOW_CONFIDENCE ? { text: LOW_NOTE, tone: "warn" } : "",
      ]),
    });
  }

  // ---- merges
  if (d.merges.length > 0) {
    const merges = [...d.merges].sort((a, z) => Number(z.proposed) - Number(a.proposed));
    b.push({
      kind: "table",
      title: "Entity merges",
      head: ["node", "rule", "observations", "detail", "status"],
      rows: capped(merges, "merges", b).map((m) => [
        nm(m.node),
        m.rule,
        `${m.a} + ${m.b}`,
        m.detail,
        m.proposed
          ? { text: `proposed (${fmtPct(m.confidence)}), to verify`, tone: "warn" }
          : { text: "confirmed", tone: "good" },
      ]),
    });
  }

  // ---- critical path
  const t = d.traces;
  if (t && (t.dominant.length > 0 || t.criticalPaths.length > 0)) {
    b.push({ kind: "heading", level: 3, text: "Critical path" });
    if (t.dominant.length > 0) {
      b.push({
        kind: "table",
        title: "Dominant dependency per route",
        head: ["route", "dominant dependency", "share of latency", "time", "traces"],
        align: ["l", "l", "r", "r", "r"],
        rows: t.dominant.map((x) => [
          nm(x.route),
          nm(x.node),
          { text: fmtPct(x.share), tone: x.share >= 0.5 ? "warn" : undefined } as CellLike,
          fmtMs(x.ms),
          String(x.traces),
        ]),
      });
    }
    const longest = t.criticalPaths[0];
    if (longest) {
      b.push({
        kind: "table",
        title: `Longest critical path: ${longest.route ? nm(longest.route) : longest.root} (${fmtMs(longest.durationMs)}, trace ${longest.traceId})`,
        head: ["segment", "service", "attributed to", "time"],
        align: ["l", "l", "l", "r"],
        rows: longest.segments.map((s) => [s.name, s.service, s.node ? nm(s.node) : "-", fmtMs(s.ms)]),
      });
    }
  }

  // ---- failure modes
  const fm = d.nodes.flatMap((n) => (n.failureModes ?? []).map((f) => ({ n, f })));
  if (fm.length > 0) {
    b.push({
      kind: "table",
      title: "Failure modes",
      head: ["node", "failure mode", "source", "severity", "classification"],
      rows: capped(fm, "failure modes", b).map(({ n, f }) => [
        nm(n.id),
        f.title,
        f.source,
        f.severity ?? "-",
        f.classification === "hypothesis" ? { text: "hypothesis", tone: "warn" } : (f.classification ?? "-"),
      ]),
    });
  }

  // ---- diagram (md / html)
  b.push({
    kind: "code",
    title: "Mermaid diagram source",
    lines: modelToMermaid(d).split("\n"),
    lang: "mermaid",
  });

  // ---- model limitations not already on the EngineResult
  const known = new Set(resultLimitations.map((l) => l.code));
  const extra = d.limitations.filter((l) => !known.has(l.code));
  for (const l of extra)
    b.push({
      kind: "text",
      tone: l.impact === "informational" ? "muted" : "warn",
      text: `Limitation: ${l.message} [${l.code}]`,
    });
  return b;
}

export function modelDiffBlocks(diff: ModelDiff): Block[] {
  const b: Block[] = [];
  const s = diff.summary;
  b.push({
    kind: "kv",
    items: [
      ["added", String(s.added)],
      ["removed", String(s.removed)],
      ["changed", String(s.changed)],
      ["result", s.unchanged ? { text: "unchanged", tone: "good" } : { text: "changed", tone: "warn" }],
    ],
  });
  const nodeRows = (ns: readonly ModelNode[], tone: "good" | "bad") =>
    ns.map((n): CellLike[] => [{ text: n.id, tone }, n.kind, fmtPct(n.confidence), sourcesOf(n.evidence)]);
  const edgeRows = (es: readonly ModelEdge[], tone: "good" | "bad") =>
    es.map((e): CellLike[] => [
      { text: `${e.from} → ${e.to}`, tone },
      e.kind,
      fmtPct(e.confidence),
      sourcesOf(e.evidence),
    ]);
  if (diff.addedNodes.length > 0)
    b.push({
      kind: "table",
      title: "Added nodes",
      head: ["node", "kind", "confidence", "sources"],
      rows: nodeRows(diff.addedNodes, "good"),
    });
  if (diff.removedNodes.length > 0)
    b.push({
      kind: "table",
      title: "Removed nodes",
      head: ["node", "kind", "confidence", "sources"],
      rows: nodeRows(diff.removedNodes, "bad"),
    });
  if (diff.addedEdges.length > 0)
    b.push({
      kind: "table",
      title: "Added edges",
      head: ["edge", "kind", "confidence", "sources"],
      rows: edgeRows(diff.addedEdges, "good"),
    });
  if (diff.removedEdges.length > 0)
    b.push({
      kind: "table",
      title: "Removed edges",
      head: ["edge", "kind", "confidence", "sources"],
      rows: edgeRows(diff.removedEdges, "bad"),
    });
  if (diff.changedKind.length > 0)
    b.push({
      kind: "table",
      title: "Changed kind",
      head: ["node", "before", "after"],
      rows: diff.changedKind.map((c) => [c.id, c.before, c.after]),
    });
  if (diff.changedConfidence.length > 0) {
    b.push({
      kind: "table",
      title: "Changed confidence",
      head: ["id", "type", "before", "after"],
      align: ["l", "l", "r", "r"],
      rows: diff.changedConfidence.map((c) => [
        c.id,
        c.type,
        fmtPct(c.before),
        { text: fmtPct(c.after), tone: c.after < c.before ? "bad" : "good" },
      ]),
    });
  }
  if (diff.changedMetrics.length > 0) {
    b.push({
      kind: "table",
      title: "Changed observed metrics",
      head: ["id", "metric", "before", "after", "change"],
      align: ["l", "l", "r", "r", "r"],
      rows: diff.changedMetrics.map((m) => [
        m.id,
        m.metric,
        fmtVal(m.before),
        fmtVal(m.after),
        m.relChange === undefined ? "-" : `${m.relChange > 0 ? "+" : ""}${(m.relChange * 100).toFixed(1)}%`,
      ]),
    });
  }
  if (diff.changedSources.length > 0) {
    b.push({
      kind: "table",
      title: "Changed evidence sources",
      head: ["node", "added", "removed"],
      rows: diff.changedSources.map((c) => [c.id, c.added.join(", ") || "-", c.removed.join(", ") || "-"]),
    });
  }
  if (s.unchanged)
    b.push({ kind: "text", tone: "muted", text: "No differences above the reporting thresholds." });
  return b;
}
