/**
 * Prometheus text exposition format (0.0.4) parser — docs/03-engines/system-model.md §1 (runtime metrics).
 * Handles `# HELP` / `# TYPE`, labels with escapes (`\\`, `\"`, `\n`), `+Inf`/`-Inf`/`NaN`,
 * optional timestamps, and groups histogram/summary series (`_bucket`/`_sum`/`_count`).
 * OpenMetrics-only syntax (exemplars after `#`, `# EOF`) is tolerated.
 */
import { histogramQuantile } from "./otlp.js";

export type PromType = "counter" | "gauge" | "histogram" | "summary" | "untyped";

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
  timestampMs?: number;
}

export interface PromFamily {
  name: string;
  type: PromType;
  help?: string;
  samples: PromSample[];
}

export interface PromHistogramSeries {
  labels: Record<string, string>;
  /** Sorted by upper bound; counts are cumulative as exposed. */
  buckets: { le: number; count: number }[];
  sum?: number;
  count?: number;
}

export interface PromParseResult {
  families: PromFamily[];
  warnings: string[];
}

const SUFFIXES = ["_bucket", "_sum", "_count", "_total", "_created", "_gcount", "_gsum"];

function parseValue(s: string): number {
  if (s === "+Inf" || s === "Inf") return Number.POSITIVE_INFINITY;
  if (s === "-Inf") return Number.NEGATIVE_INFINITY;
  if (s === "NaN") return Number.NaN;
  const n = Number(s);
  return n;
}

function unescapeHelp(s: string): string {
  return s.replace(/\\(\\|n)/g, (_m, c: string) => (c === "n" ? "\n" : "\\"));
}

/** Parses `{a="x",b="y\"z"}` starting at `i` (which points at "{"). Returns labels and the index after "}". */
function parseLabels(
  line: string,
  start: number,
): { labels: Record<string, string>; end: number } | undefined {
  const labels: Record<string, string> = {};
  let i = start + 1;
  const n = line.length;
  while (i < n) {
    while (i < n && (line[i] === " " || line[i] === ",")) i++;
    if (line[i] === "}") return { labels, end: i + 1 };
    const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(line.slice(i));
    if (!m) return undefined;
    const key = m[0];
    i += key.length;
    while (line[i] === " ") i++;
    if (line[i] !== "=") return undefined;
    i++;
    while (line[i] === " ") i++;
    if (line[i] !== '"') return undefined;
    i++;
    let val = "";
    let closed = false;
    while (i < n) {
      const ch = line[i] as string;
      if (ch === "\\") {
        const nx = line[i + 1];
        if (nx === "n") val += "\n";
        else if (nx === "\\") val += "\\";
        else if (nx === '"') val += '"';
        else val += `\\${nx ?? ""}`;
        i += 2;
        continue;
      }
      if (ch === '"') {
        closed = true;
        i++;
        break;
      }
      val += ch;
      i++;
    }
    if (!closed) return undefined;
    labels[key] = val;
  }
  return undefined;
}

function baseName(sample: string, types: Map<string, PromType>): string {
  if (types.has(sample)) return sample;
  for (const suf of SUFFIXES) {
    if (sample.endsWith(suf)) {
      const b = sample.slice(0, -suf.length);
      if (types.has(b)) return b;
    }
  }
  return sample;
}

export function parsePrometheus(text: string): PromParseResult {
  const warnings: string[] = [];
  const types = new Map<string, PromType>();
  const helps = new Map<string, string>();
  const order: string[] = [];
  const fam = new Map<string, PromFamily>();
  const family = (name: string): PromFamily => {
    let f = fam.get(name);
    if (!f) {
      f = { name, type: types.get(name) ?? "untyped", samples: [] };
      const h = helps.get(name);
      if (h !== undefined) f.help = h;
      fam.set(name, f);
      order.push(name);
    }
    return f;
  };
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = (lines[ln] as string).trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      const m = /^#\s+(HELP|TYPE)\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, what, name, rest] = m as unknown as [string, string, string, string];
      if (what === "TYPE") {
        const t = rest.trim().toLowerCase();
        const ty: PromType = (["counter", "gauge", "histogram", "summary"] as const).includes(t as never)
          ? (t as PromType)
          : "untyped";
        types.set(name, ty);
        const f = fam.get(name);
        if (f) f.type = ty;
      } else {
        helps.set(name, unescapeHelp(rest));
        const f = fam.get(name);
        if (f) f.help = unescapeHelp(rest);
      }
      continue;
    }
    const nm = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(line);
    if (!nm) {
      if (warnings.length < 50) warnings.push(`line ${ln + 1}: cannot parse metric name`);
      continue;
    }
    const name = nm[0];
    let i = name.length;
    let labels: Record<string, string> = {};
    if (line[i] === "{") {
      const r = parseLabels(line, i);
      if (!r) {
        if (warnings.length < 50) warnings.push(`line ${ln + 1}: malformed labels`);
        continue;
      }
      labels = r.labels;
      i = r.end;
    }
    // Drop OpenMetrics exemplars (" # {...} v").
    let rest = line.slice(i).trim();
    const hash = rest.indexOf(" #");
    if (hash >= 0) rest = rest.slice(0, hash).trim();
    const parts = rest.split(/\s+/);
    const value = parseValue(parts[0] ?? "");
    if (parts[0] === undefined || parts[0] === "" || (Number.isNaN(value) && parts[0] !== "NaN")) {
      if (warnings.length < 50) warnings.push(`line ${ln + 1}: bad value`);
      continue;
    }
    const sample: PromSample = { name, labels, value };
    if (parts[1] !== undefined) {
      const ts = Number(parts[1]);
      if (Number.isFinite(ts)) sample.timestampMs = ts;
    }
    family(baseName(name, types)).samples.push(sample);
  }
  return { families: order.map((n) => fam.get(n) as PromFamily), warnings };
}

const labelKey = (labels: Record<string, string>, omit: string): string =>
  Object.keys(labels)
    .filter((k) => k !== omit)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");

/** Groups a histogram family into series (by labels without `le`). */
export function histogramSeries(f: PromFamily): PromHistogramSeries[] {
  const out = new Map<string, PromHistogramSeries>();
  const get = (labels: Record<string, string>): PromHistogramSeries => {
    const k = labelKey(labels, "le");
    let s = out.get(k);
    if (!s) {
      const l = { ...labels };
      delete l.le;
      s = { labels: l, buckets: [] };
      out.set(k, s);
    }
    return s;
  };
  for (const smp of f.samples) {
    if (smp.name === `${f.name}_bucket`) {
      const le = parseValue(smp.labels.le ?? "+Inf");
      get(smp.labels).buckets.push({ le, count: smp.value });
    } else if (smp.name === `${f.name}_sum`) get(smp.labels).sum = smp.value;
    else if (smp.name === `${f.name}_count`) get(smp.labels).count = smp.value;
  }
  for (const s of out.values()) s.buckets.sort((a, b) => a.le - b.le);
  return [...out.values()];
}

/** histogram_quantile over cumulative Prometheus buckets. */
export function promHistogramQuantile(q: number, s: PromHistogramSeries): number {
  const finite = s.buckets.filter((b) => Number.isFinite(b.le));
  const bounds = finite.map((b) => b.le);
  const counts: number[] = [];
  let prev = 0;
  for (const b of s.buckets) {
    counts.push(Math.max(0, b.count - prev));
    prev = b.count;
  }
  if (counts.length === bounds.length) counts.push(0);
  return histogramQuantile(q, bounds, counts);
}
