/**
 * Threshold expressions. See docs/08-configuration.md §4.
 *
 *   threshold := metric WS? op WS? value
 *   metric    := (scope ".")? stat
 *   scope     := "http" | "scenario.<name>" | "endpoint.<METHOD /path>"
 *   stat      := "p(" number ")" | "p50" | "p90" | "p95" | "p99" | "avg" | "max" | "rps" | "error_rate" | "timeout_rate" | ...
 *   op        := "<" | "<=" | ">" | ">=" | "=="
 *   value     := number unit?
 *
 * Hand-written recursive-descent parser over a character cursor. No eval.
 * Values are normalised: ms for latency stats, 0..1 for rate stats, per-second for rps.
 */
import { ConfigError } from "../errors.js";
import { parseDuration, parsePercent, parseRate } from "./units.js";

export type ThresholdOp = "<" | "<=" | ">" | ">=" | "==";
/** Normalised unit of `value`. */
export type ThresholdUnit = "ms" | "ratio" | "per_s" | "count";

export interface Threshold {
  /** Canonical metric: `<scope>.<stat>`, e.g. "http.p95", "scenario.checkout.p99", "endpoint.GET /api.p(99.9)" → stat "p99.9". */
  metric: string;
  /** "http" | "scenario.<name>" | "endpoint.<METHOD /path>" */
  scope: string;
  /** Canonical stat: "p95", "p99.9", "avg", "max", "min", "med", "rps", "error_rate", "timeout_rate", "count", ... */
  stat: string;
  /** For percentile stats: 0..100. */
  percentile?: number;
  op: ThresholdOp;
  value: number;
  unit?: ThresholdUnit;
  /** Original expression, for evidence/reporting. */
  source: string;
}

export interface ThresholdEntry extends Threshold {
  abortOnFail: boolean;
  delayAbortEvalMs: number;
}

const LATENCY_STATS = new Set(["avg", "mean", "max", "min", "med", "median"]);
const RATIO_STATS = new Set(["error_rate", "timeout_rate", "success_rate", "check_rate"]);
const RATE_STATS = new Set(["rps", "throughput"]);
const COUNT_STATS = new Set(["count", "errors", "timeouts", "requests"]);
const STAT_ALIASES: Record<string, string> = { mean: "avg", median: "med", throughput: "rps" };

function fail(expr: string, msg: string, pos?: number): ConfigError {
  const at = pos === undefined ? "" : ` at column ${pos + 1}`;
  return new ConfigError("SW_CONFIG_THRESHOLD", `Invalid threshold "${expr}": ${msg}${at}`, {
    hint: 'Examples: "p(95) < 300ms", "http.p99 <= 1s", "error_rate < 1%", "rps > 200"',
  });
}

class Cursor {
  i = 0;
  constructor(readonly s: string) {}
  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] as string)) this.i++;
  }
  peek(): string {
    return this.s[this.i] ?? "";
  }
  eof(): boolean {
    return this.i >= this.s.length;
  }
}

/** Locate the operator: first '<', '>', '=' or '!' outside parentheses. */
function findOp(c: Cursor): number {
  let depth = 0;
  for (let i = c.i; i < c.s.length; i++) {
    const ch = c.s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === "<" || ch === ">" || ch === "=")) return i;
  }
  return -1;
}

function parseStat(raw: string, expr: string): { stat: string; percentile?: number } {
  const s = raw.trim();
  // p(95), p(99.9)
  let m = /^p\(\s*(\d+(?:\.\d+)?)\s*\)$/i.exec(s);
  if (!m) m = /^p(\d+(?:\.\d+)?)$/i.exec(s);
  if (m) {
    let p = Number(m[1]);
    // p999 shorthand = 99.9
    if (!s.includes("(") && /^p9{3,}$/i.test(s)) p = Number(`99.${(m[1] as string).slice(2)}`);
    if (!(p >= 0 && p <= 100)) throw fail(expr, `percentile ${p} out of range 0..100`);
    return { stat: `p${p}`, percentile: p };
  }
  const lower = s.toLowerCase();
  if (LATENCY_STATS.has(lower) || RATIO_STATS.has(lower) || RATE_STATS.has(lower) || COUNT_STATS.has(lower)) {
    return { stat: STAT_ALIASES[lower] ?? lower };
  }
  throw fail(expr, `unknown statistic "${s}"`);
}

/** Splits "scenario.checkout.p(99.9)" into scope + stat. Defaults scope to "http". */
function parseMetric(raw: string, expr: string): { scope: string; stat: string; percentile?: number } {
  const s = raw.trim();
  if (s === "") throw fail(expr, "missing metric", 0);
  let statStart: number;
  if (s.endsWith(")")) {
    statStart = s.toLowerCase().lastIndexOf("p(");
    if (statStart < 0) throw fail(expr, `unbalanced parentheses in "${s}"`);
  } else {
    statStart = s.lastIndexOf(".") + 1;
  }
  const statRaw = s.slice(statStart);
  const scopeRaw = statStart > 0 ? s.slice(0, statStart - 1) : "";
  if (statStart > 0 && s[statStart - 1] !== ".") throw fail(expr, `expected "." before statistic in "${s}"`);
  const st = parseStat(statRaw, expr);
  const scope = scopeRaw === "" ? "http" : parseScope(scopeRaw, expr);
  return { scope, ...st };
}

function parseScope(raw: string, expr: string): string {
  if (raw === "http") return "http";
  if (raw.startsWith("scenario.")) {
    const name = raw.slice("scenario.".length);
    if (name === "") throw fail(expr, "empty scenario name");
    return `scenario.${name}`;
  }
  if (raw.startsWith("endpoint.")) {
    const ep = raw.slice("endpoint.".length).trim();
    const m = /^([A-Za-z]+)\s+(\S.*)$/.exec(ep);
    if (!m) throw fail(expr, `endpoint scope must be "endpoint.<METHOD /path>", got "${raw}"`);
    return `endpoint.${(m[1] as string).toUpperCase()} ${m[2]}`;
  }
  throw fail(
    expr,
    `unknown metric scope "${raw}" (expected http, scenario.<name> or endpoint.<METHOD /path>)`,
  );
}

function parseOp(c: Cursor, expr: string): ThresholdOp {
  const two = c.s.slice(c.i, c.i + 2);
  if (two === "<=" || two === ">=" || two === "==") {
    c.i += 2;
    return two;
  }
  const one = c.peek();
  if (one === "<" || one === ">") {
    c.i += 1;
    return one;
  }
  throw fail(expr, `expected operator (<, <=, >, >=, ==)`, c.i);
}

function unitFor(stat: string): ThresholdUnit {
  if (stat.startsWith("p") && /^p\d/.test(stat)) return "ms";
  if (LATENCY_STATS.has(stat)) return "ms";
  if (RATIO_STATS.has(stat)) return "ratio";
  if (RATE_STATS.has(stat)) return "per_s";
  return "count";
}

function parseValue(raw: string, unit: ThresholdUnit, expr: string): number {
  const s = raw.trim();
  if (s === "") throw fail(expr, "missing value");
  try {
    switch (unit) {
      case "ms":
        return parseDuration(s);
      case "ratio": {
        // "1%" → 0.01; bare number ≤ 1 is a fraction
        return parsePercent(s);
      }
      case "per_s":
        return parseRate(s);
      case "count": {
        if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("not a number");
        return Number(s);
      }
    }
  } catch {
    throw fail(
      expr,
      `invalid value "${s}" for a ${unit === "ms" ? "latency" : unit === "ratio" ? "rate" : unit === "per_s" ? "throughput" : "count"} statistic`,
    );
  }
}

/** Parse a full threshold expression like "p(95) < 300ms" or "scenario.checkout.p99<=800ms". */
export function parseThreshold(expr: string): Threshold {
  if (typeof expr !== "string") throw fail(String(expr), "expression must be a string");
  const c = new Cursor(expr);
  c.ws();
  const opPos = findOp(c);
  if (opPos < 0) throw fail(expr, "missing operator (<, <=, >, >=, ==)");
  const metric = parseMetric(expr.slice(c.i, opPos), expr);
  c.i = opPos;
  const op = parseOp(c, expr);
  c.ws();
  const unit = unitFor(metric.stat);
  const value = parseValue(expr.slice(c.i), unit, expr);
  const t: Threshold = {
    metric: `${metric.scope}.${metric.stat}`,
    scope: metric.scope,
    stat: metric.stat,
    op,
    value,
    unit,
    source: expr.trim(),
  };
  if (metric.percentile !== undefined) t.percentile = metric.percentile;
  return t;
}

export type ThresholdSpec =
  | string
  | { expr: string; abortOnFail?: boolean; delayAbortEval?: string | number }
  | Array<string | { expr: string; abortOnFail?: boolean; delayAbortEval?: string | number }>;

/**
 * Metric-keyed form: `{ "http.p95": "< 300ms" }`, or k6-style `{ "http": "p(95) < 300ms" }`.
 * If `expr` starts with an operator, `metric` is the full metric. Otherwise `expr` is a full
 * threshold whose scope is taken from `metric` when the expression itself has none.
 */
export function parseThresholdEntry(
  metric: string,
  spec: string | { expr: string; abortOnFail?: boolean; delayAbortEval?: string | number },
): ThresholdEntry {
  const obj = typeof spec === "string" ? { expr: spec } : spec;
  if (!obj || typeof obj.expr !== "string") {
    throw fail(`${metric}: ${JSON.stringify(spec)}`, 'expected a string or { expr: "..." }');
  }
  const e = obj.expr.trim();
  let t: Threshold;
  if (/^[<>=]/.test(e)) {
    t = parseThreshold(`${metric} ${e}`);
  } else {
    const inner = parseThreshold(e);
    const innerHasScope = /^(http|scenario\.|endpoint\.)/.test(e);
    if (innerHasScope || metric === "" || metric === "http") t = inner;
    else {
      // key is a scope like "scenario.checkout"
      const scope = parseScope(metric, `${metric}: ${e}`);
      t = { ...inner, scope, metric: `${scope}.${inner.stat}` };
    }
  }
  let delay = 0;
  if (obj.delayAbortEval !== undefined)
    delay = parseDuration(obj.delayAbortEval, `thresholds.${metric}.delayAbortEval`);
  return { ...t, source: `${metric}: ${e}`, abortOnFail: obj.abortOnFail ?? false, delayAbortEvalMs: delay };
}

/** Parses a whole thresholds record (arrays allowed as values). Errors carry the key path. */
export function parseThresholds(record: Record<string, ThresholdSpec> | undefined): ThresholdEntry[] {
  const out: ThresholdEntry[] = [];
  if (!record) return out;
  for (const [k, v] of Object.entries(record)) {
    const specs = Array.isArray(v) ? v : [v];
    for (const s of specs) {
      try {
        out.push(parseThresholdEntry(k, s));
      } catch (e) {
        if (e instanceof ConfigError) {
          throw new ConfigError("SW_CONFIG_THRESHOLD", `thresholds.${k}: ${e.message}`, {
            hint: e.hint,
            details: { path: `thresholds.${k}` },
          });
        }
        throw e;
      }
    }
  }
  return out;
}

const EPS = 1e-9;

/** True when the threshold PASSES for the observed value (in normalised units). NaN never passes. */
export function evaluateThreshold(t: Pick<Threshold, "op" | "value">, actual: number): boolean {
  if (Number.isNaN(actual)) return false;
  switch (t.op) {
    case "<":
      return actual < t.value;
    case "<=":
      return actual <= t.value + EPS * Math.max(1, Math.abs(t.value));
    case ">":
      return actual > t.value;
    case ">=":
      return actual >= t.value - EPS * Math.max(1, Math.abs(t.value));
    case "==":
      return Math.abs(actual - t.value) <= EPS * Math.max(1, Math.abs(t.value));
  }
}

/** Renders a threshold back to a parseable expression (round-trip helper). */
export function formatThreshold(t: Threshold): string {
  const stat = t.percentile !== undefined ? `p(${t.percentile})` : t.stat;
  let v: string;
  switch (t.unit) {
    case "ms":
      v = `${t.value}ms`;
      break;
    case "ratio":
      v = `${t.value}`;
      break;
    case "per_s":
      v = `${t.value}/s`;
      break;
    default:
      v = `${t.value}`;
  }
  return `${t.scope}.${stat} ${t.op} ${v}`;
}
