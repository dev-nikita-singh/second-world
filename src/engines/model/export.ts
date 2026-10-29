/**
 * Model exports — docs/03-engines/system-model.md §5: JSON (canonical), Graphviz DOT, Mermaid.
 * Low-confidence (< 0.6) nodes/edges are drawn dotted; proposed (fuzzy) merges are marked "?".
 */
import type { ModelData, ModelEdge, ModelNode, ModelNodeKind } from "./types.js";

/** Deterministic JSON: object keys sorted, nodes/edges sorted by id, merges by node/rule/a/b. */
export function toCanonicalJson(model: ModelData, indent = 2): string {
  const sorted: ModelData = {
    ...model,
    nodes: [...model.nodes].sort((a, b) => cmp(a.id, b.id)),
    edges: [...model.edges].sort((a, b) => cmp(a.id, b.id)),
    merges: [...model.merges].sort(
      (a, b) => cmp(a.node, b.node) || cmp(a.rule, b.rule) || cmp(a.a, b.a) || cmp(a.b, b.b),
    ),
  };
  return JSON.stringify(sortKeys(sorted), null, indent);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Recursively sort object keys (iterative; arrays keep their order). */
export function sortKeys(value: unknown): unknown {
  const root: { v: unknown } = { v: undefined };
  const stack: { src: unknown; set: (x: unknown) => void }[] = [
    {
      src: value,
      set: (x) => {
        root.v = x;
      },
    },
  ];
  while (stack.length > 0) {
    const { src, set } = stack.pop() as { src: unknown; set: (x: unknown) => void };
    if (Array.isArray(src)) {
      const out: unknown[] = new Array(src.length);
      set(out);
      src.forEach((x, i) => {
        stack.push({
          src: x,
          set: (y) => {
            out[i] = y;
          },
        });
      });
    } else if (src !== null && typeof src === "object") {
      const out: Record<string, unknown> = {};
      set(out);
      for (const k of Object.keys(src).sort()) {
        const v = (src as Record<string, unknown>)[k];
        if (v === undefined) continue;
        out[k] = undefined;
        stack.push({
          src: v,
          set: (y) => {
            out[k] = y;
          },
        });
      }
    } else set(src);
  }
  return root.v;
}

const DOT_SHAPES: Record<ModelNodeKind, string> = {
  service: "box3d",
  route: "box",
  handler: "component",
  datastore: "cylinder",
  cache: "cylinder",
  queue: "cds",
  external: "doubleoctagon",
  module: "note",
};

/** Escape a DOT double-quoted string. */
export function dotEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
}

const pct = (c: number) => `${Math.round(c * 100)}%`;

function nodeLabel(n: ModelNode): string {
  const parts = [n.names[0] ?? n.id, `${n.kind} · ${pct(n.confidence)}${n.proposedMerge ? " ?" : ""}`];
  if (n.observed?.p95Ms !== undefined) parts.push(`p95 ${n.observed.p95Ms} ms`);
  return parts.join("\n");
}

function edgeLabel(e: ModelEdge): string {
  const parts: string[] = [e.kind];
  if (e.observed?.callsPerRequest !== undefined) parts.push(`${e.observed.callsPerRequest}/req`);
  if (e.observed?.p95Ms !== undefined) parts.push(`p95 ${e.observed.p95Ms} ms`);
  return parts.join(" ");
}

export function modelToDot(model: Pick<ModelData, "nodes" | "edges">, opts: { title?: string } = {}): string {
  const lines = [
    `digraph "${dotEscape(opts.title ?? "system-model")}" {`,
    "  rankdir=LR;",
    '  node [fontname="Helvetica"];',
  ];
  for (const n of [...model.nodes].sort((a, b) => cmp(a.id, b.id))) {
    const style = n.confidence < 0.6 ? ', style="dotted"' : "";
    lines.push(
      `  "${dotEscape(n.id)}" [label="${dotEscape(nodeLabel(n))}", shape=${DOT_SHAPES[n.kind]}${style}];`,
    );
  }
  for (const e of [...model.edges].sort((a, b) => cmp(a.id, b.id))) {
    const style = e.confidence < 0.6 ? ', style="dotted"' : "";
    lines.push(
      `  "${dotEscape(e.from)}" -> "${dotEscape(e.to)}" [label="${dotEscape(edgeLabel(e))}"${style}];`,
    );
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/** Escape text inside a Mermaid quoted label (entity codes; no raw quotes, brackets, pipes or newlines). */
export function mermaidEscape(s: string): string {
  return s
    .replace(/&/g, "#amp;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\|/g, "#124;")
    .replace(/[[\]{}()]/g, (c) => `#${c.charCodeAt(0)};`)
    .replace(/\r?\n/g, "<br/>");
}

const MERMAID_SHAPES: Record<ModelNodeKind, [string, string]> = {
  service: ["[[", "]]"],
  route: ["[", "]"],
  handler: ["[", "]"],
  datastore: ["[(", ")]"],
  cache: ["[(", ")]"],
  queue: ["[/", "/]"],
  external: ["{{", "}}"],
  module: ["[", "]"],
};

export function modelToMermaid(model: Pick<ModelData, "nodes" | "edges">): string {
  const ids = new Map<string, string>();
  const nodes = [...model.nodes].sort((a, b) => cmp(a.id, b.id));
  nodes.forEach((n, i) => {
    ids.set(n.id, `n${i}`);
  });
  const lines = ["flowchart LR"];
  for (const n of nodes) {
    const [o, c] = MERMAID_SHAPES[n.kind];
    const label = mermaidEscape(nodeLabel(n));
    lines.push(`  ${ids.get(n.id)}${o}"${label}"${c}`);
  }
  for (const e of [...model.edges].sort((a, b) => cmp(a.id, b.id))) {
    const f = ids.get(e.from);
    const t = ids.get(e.to);
    if (!f || !t) continue;
    const arrow = e.confidence < 0.6 ? "-.->" : "-->";
    lines.push(`  ${f} ${arrow}|"${mermaidEscape(edgeLabel(e))}"| ${t}`);
  }
  return `${lines.join("\n")}\n`;
}
