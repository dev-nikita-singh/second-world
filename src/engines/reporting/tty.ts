/**
 * Human terminal summary. docs/03-engines/evidence-and-history.md §A.4–A.5,
 * docs/03-engines/performance-lab.md §4/§9.
 *
 * Colour via picocolors, enabled only when `color` is true. `resolveColor()` gives the
 * auto default: NO_COLOR disables, FORCE_COLOR enables, otherwise stdout.isTTY.
 * ASCII mode (TERM=dumb or SW_ASCII=1, or `ascii: true`) avoids box-drawing and
 * symbol characters. Returns a string; printing is the CLI's job.
 */
import { dataBlocks } from "./dispatch.js";
import Table from "cli-table3";
import pc from "picocolors";
import type { EngineResult, Finding, Severity } from "../../core/evidence/schemas.js";
import type { PerformanceData } from "../performance/types.js";
import { type Block, type CellLike, cellText, cellTone, type Tone } from "./blocks.js";
import {
  type CombinedReport,
  fmtDuration,
  fmtMs,
  fmtNum,
  fmtPct,
  fmtThresholdValue,
  isPerformanceData,
  isFailingFinding,
  locationOf,
  sortFindings,
  thresholdsOf,
} from "./model.js";

export interface TtyOptions {
  color?: boolean;
  ascii?: boolean;
  /** Max findings listed per engine (default 50). */
  maxFindings?: number;
}

type Env = Record<string, string | undefined>;

/** Auto colour decision for a stream. */
export function resolveColor(env: Env = process.env, isTTY: boolean = process.stdout.isTTY === true): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false") return true;
  if (env.TERM === "dumb") return false;
  return isTTY;
}

/** Auto ASCII decision. */
export function resolveAscii(env: Env = process.env): boolean {
  return env.TERM === "dumb" || env.SW_ASCII === "1";
}

const ASCII_CHARS = {
  top: "-",
  "top-mid": "+",
  "top-left": "+",
  "top-right": "+",
  bottom: "-",
  "bottom-mid": "+",
  "bottom-left": "+",
  "bottom-right": "+",
  left: "|",
  "left-mid": "+",
  mid: "-",
  "mid-mid": "+",
  right: "|",
  "right-mid": "+",
  middle: "|",
} as const;

interface Ctx {
  c: ReturnType<typeof pc.createColors>;
  ascii: boolean;
  sym: { ok: string; fail: string; warn: string; bullet: string; dash: string; dot: string; pass: string; failLabel: string };
}

function makeTable(ctx: Ctx, head: string[], aligns?: ("left" | "right")[]): Table.Table {
  return new Table({
    head: head.map((h) => ctx.c.bold(h)),
    style: { head: [], border: [], "padding-left": 1, "padding-right": 1 },
    ...(ctx.ascii ? { chars: ASCII_CHARS } : {}),
    ...(aligns ? { colAligns: aligns } : {}),
    wordWrap: true,
  });
}

function sevColor(ctx: Ctx, s: Severity): string {
  const { c } = ctx;
  switch (s) {
    case "critical":
      return c.bold(c.red(s));
    case "high":
      return c.red(s);
    case "medium":
      return c.yellow(s);
    case "low":
      return c.cyan(s);
    default:
      return c.dim(s);
  }
}

function statusColor(ctx: Ctx, s: EngineResult["status"]): string {
  const { c } = ctx;
  if (s === "passed") return c.green(s);
  if (s === "failed" || s === "error") return c.red(s);
  if (s === "partial" || s === "cancelled") return c.yellow(s);
  return c.dim(s);
}

function renderPerformance(ctx: Ctx, d: PerformanceData, out: string[]): void {
  const { c } = ctx;
  const t = d.totals;
  const L = d.latency;
  const model = d.model === "open" ? `open${d.arrival ? `/${d.arrival}` : ""}` : d.model;
  out.push(
    `${c.dim("target")} ${d.target}  ${c.dim("model")} ${model}  ${c.dim("measured")} ${fmtDuration(d.window.measuredMs)}  ${c.dim("stop")} ${d.window.stopReason}`,
  );
  const summary = makeTable(ctx, ["requests", "ok", "failed", "rps", "error rate", "p50", "p95", "p99", "max"], [
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
  ]);
  summary.push([
    String(t.requests),
    String(t.ok),
    t.failed > 0 ? c.red(String(t.failed)) : String(t.failed),
    fmtNum(t.rps),
    t.errorRate > 0 ? c.red(fmtPct(t.errorRate)) : fmtPct(t.errorRate),
    fmtMs(L.corrected.p50),
    fmtMs(L.corrected.p95),
    fmtMs(L.corrected.p99),
    fmtMs(L.corrected.max),
  ]);
  summary.push([
    { content: c.dim("raw (uncorrected) latency"), colSpan: 5 },
    c.dim(fmtMs(L.raw.p50)),
    c.dim(fmtMs(L.raw.p95)),
    c.dim(fmtMs(L.raw.p99)),
    c.dim(fmtMs(L.raw.max)),
  ]);
  out.push(summary.toString());
  if (t.targetRate !== undefined && t.achievedRate !== undefined) {
    out.push(`${c.dim("rate")} target ${fmtNum(t.targetRate)}/s ${ctx.sym.dash} achieved ${fmtNum(t.achievedRate)}/s`);
  }
  const extras: string[] = [];
  if (t.timeouts > 0) extras.push(`timeouts ${t.timeouts}`);
  if (t.dropped > 0) extras.push(`dropped ${t.dropped}`);
  if (t.interrupted > 0) extras.push(`interrupted ${t.interrupted}`);
  if (extras.length > 0) out.push(c.yellow(extras.join(", ")));

  if (d.endpoints.length > 0) {
    const ep = makeTable(ctx, ["endpoint", "requests", "rps", "errors", "p50", "p95", "p99"], [
      "left",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
    ]);
    for (const e of [...d.endpoints].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
      ep.push([
        e.key,
        String(e.requests),
        fmtNum(e.rps),
        e.errorRate > 0 ? c.red(fmtPct(e.errorRate)) : fmtPct(e.errorRate),
        fmtMs(e.latency.corrected.p50),
        fmtMs(e.latency.corrected.p95),
        fmtMs(e.latency.corrected.p99),
      ]);
    }
    out.push(ep.toString());
  }

  if (d.errors.length > 0) {
    out.push(c.bold("Errors"));
    for (const e of d.errors) out.push(`  ${ctx.sym.bullet} ${e.kind}: ${e.count}`);
  }

  const g = d.generator;
  const gen = `generator: event-loop p99 ${fmtMs(g.eventLoopDelayP99Ms)}, cpu ${fmtNum(g.cpuPercent, 0)}%, lag p99 ${fmtMs(g.schedulingLagP99Ms)}${(g.workers ?? 1) > 1 ? `, workers ${g.workers}` : ""}`;
  out.push(g.saturated ? c.yellow(`${ctx.sym.warn} ${gen} ${ctx.sym.dash} SATURATED`) : c.dim(gen));
  if (g.saturated) {
    for (const r of g.reasons ?? []) out.push(c.yellow(`    ${ctx.sym.bullet} ${r}`));
    for (const r of g.remedies ?? []) out.push(c.dim(`    fix: ${r}`));
  }
}

function tone(ctx: Ctx, t: Tone | undefined, s: string): string {
  const { c } = ctx;
  if (t === "good") return c.green(s);
  if (t === "bad") return c.red(s);
  if (t === "warn") return c.yellow(s);
  if (t === "muted") return c.dim(s);
  return s;
}

const cell = (ctx: Ctx, x: CellLike): string => tone(ctx, cellTone(x), cellText(x));

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const SPARK_ASCII = ["_", ".", "-", "~", "=", "+", "*", "#"];

/** One-line sparkline (min..max scaled). */
export function sparkline(values: readonly number[], ascii = false): string {
  const chars = ascii ? SPARK_ASCII : SPARK;
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return "";
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return values
    .map((v) => {
      if (!Number.isFinite(v)) return " ";
      const i = hi === lo ? 0 : Math.round(((v - lo) / (hi - lo)) * (chars.length - 1));
      return chars[i] ?? " ";
    })
    .join("");
}

function renderBlocks(ctx: Ctx, blocks: readonly Block[], out: string[]): void {
  const { c } = ctx;
  for (const b of blocks) {
    switch (b.kind) {
      case "heading":
        out.push(c.bold(b.text));
        break;
      case "kv": {
        const w = Math.max(...b.items.map(([k]) => k.length));
        for (const [k, v] of b.items) out.push(`  ${c.dim(k.padEnd(w))}  ${cell(ctx, v)}`);
        break;
      }
      case "table": {
        if (b.title) out.push(c.bold(b.title));
        const tb = makeTable(ctx, b.head, b.align?.map((a) => (a === "r" ? "right" : "left")));
        for (const row of b.rows) tb.push(row.map((x) => cell(ctx, x)));
        out.push(tb.toString());
        break;
      }
      case "text":
        out.push(tone(ctx, b.tone, b.tone === "warn" ? `${ctx.sym.warn} ${b.text}` : b.text));
        break;
      case "quote":
        out.push(c.bold(b.title));
        out.push(`  ${c.bold(ctx.ascii && b.ascii !== undefined ? b.ascii : b.text)}`);
        break;
      case "spark": {
        const xs = b.values.filter((v) => Number.isFinite(v));
        const lo = xs.length > 0 ? Math.min(...xs) : 0;
        const hi = xs.length > 0 ? Math.max(...xs) : 0;
        out.push(`${c.dim(b.title)} ${sparkline(b.values, ctx.ascii)} ${c.dim(`${fmtNum(lo, 1)}..${fmtNum(hi, 1)} ${b.unit}`)}`);
        if (b.mark && b.mark.to > b.mark.from) {
          // marker row aligned under the sparkline: ^ under the marked windows
          const row = b.values.map((_, i) => (i >= b.mark!.from && i < b.mark!.to ? "^" : " ")).join("");
          out.push(`${" ".repeat(b.title.length + 1)}${c.yellow(row)} ${c.dim(b.mark.label)}`);
        }
        break;
      }
      case "code":
        // diagram sources (mermaid) are for md/html; the terminal shows the tables instead
        if (b.lang === "mermaid") break;
        out.push(c.dim(b.title));
        for (const l of b.lines) out.push(`    ${l}`);
        break;
    }
  }
}

const ASCII_FOLD: [RegExp, string][] = [
  [/λ/g, "lambda"],
  [/σ/g, "sigma"],
  [/κ/g, "kappa"],
  [/²/g, "^2"],
  [/[→⇒]/g, "->"],
  [/±/g, "+/-"],
  [/[−–—]/g, "-"],
  [/·/g, "|"],
  [/µ/g, "u"],
  [/…/g, "..."],
  [/≥/g, ">="],
  [/≤/g, "<="],
  [/[✗✖]/g, "x"],
  [/✔/g, "v"],
];

/** Replace common symbols with ASCII equivalents and drop anything else non-ASCII. */
export function asciiFold(s: string): string {
  let r = s;
  for (const [re, to] of ASCII_FOLD) r = r.replace(re, to);
  return r.replace(/[^\x00-\x7f]/g, "?");
}

function newCtx(color: boolean, ascii: boolean): Ctx {
  return {
    c: pc.createColors(color),
    ascii,
    sym: ascii
      ? { ok: "PASS", fail: "FAIL", warn: "!", bullet: "-", dash: "-", dot: "|", pass: "PASS", failLabel: "FAIL" }
      : { ok: "✔", fail: "✖", warn: "⚠", bullet: "•", dash: "—", dot: "·", pass: "✔ PASS", failLabel: "✖ FAIL" },
  };
}

/** Render blocks on their own (e.g. a history comparison outside a combined report). */
export function renderBlocksTty(blocks: readonly Block[], opts: TtyOptions = {}): string {
  const ascii = opts.ascii ?? resolveAscii();
  const ctx = newCtx(opts.color ?? resolveColor(), ascii);
  const out: string[] = [];
  renderBlocks(ctx, blocks, out);
  const text = `${out.join("\n")}\n`;
  return ascii ? asciiFold(text) : text;
}

function renderThresholds(ctx: Ctx, r: EngineResult, out: string[]): void {
  const ths = thresholdsOf(r);
  if (ths.length === 0) return;
  const { c } = ctx;
  const tb = makeTable(ctx, ["", "threshold", "actual"], ["left", "left", "right"]);
  for (const t of ths) {
    tb.push([
      t.passed ? c.green(ctx.sym.ok) : c.red(ctx.sym.fail),
      t.expression + (t.aborted ? c.yellow(" (aborted run)") : ""),
      t.passed ? fmtThresholdValue(t.actual, t.unit) : c.red(fmtThresholdValue(t.actual, t.unit)),
    ]);
  }
  out.push(c.bold("Thresholds"));
  out.push(tb.toString());
}

function renderFindings(ctx: Ctx, findings: Finding[], failOn: CombinedReport["failOn"], max: number, out: string[]): void {
  if (findings.length === 0) return;
  const { c } = ctx;
  const sorted = sortFindings(findings);
  const tb = makeTable(ctx, ["severity", "class", "finding", "where"]);
  for (const f of sorted.slice(0, max)) {
    const mark = isFailingFinding(f, failOn) ? c.red(ctx.sym.fail) : " ";
    tb.push([`${mark} ${sevColor(ctx, f.severity)}`, f.classification, f.title, locationOf(f)]);
  }
  out.push(c.bold(`Findings (${findings.length})`));
  out.push(tb.toString());
  if (sorted.length > max) out.push(c.dim(`  ... ${sorted.length - max} more in the JSON report`));
}

/** Render the human summary. */
export function renderTty(report: CombinedReport, opts: TtyOptions = {}): string {
  const color = opts.color ?? resolveColor();
  const ascii = opts.ascii ?? resolveAscii();
  const ctx = newCtx(color, ascii);
  const { c } = ctx;
  const out: string[] = [];
  const v = report.verdict;

  out.push(
    `${c.bold("SECOND WORLD")} ${c.dim(`run ${report.runId}`)} ${c.dim(`${ctx.sym.dot} ${fmtDuration(report.durationMs)} ${ctx.sym.dot} ${report.toolVersion}`)}`,
  );
  const verdictLabel = v.passed ? c.bold(c.green(ctx.sym.pass)) : c.bold(c.red(ctx.sym.failLabel));
  out.push(`${verdictLabel} ${c.dim(`(exit ${v.exitCode}, fail-on ${report.failOn})`)} ${v.reasons.join("; ")}`);

  for (const r of report.results) {
    out.push("");
    out.push(`${c.bold(c.cyan(`[${r.engine}]`))} ${statusColor(ctx, r.status)} ${c.dim(fmtDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt)))}`);
    if (isPerformanceData(r.data)) renderPerformance(ctx, r.data, out);
    else {
      const blocks = dataBlocks(r);
      if (blocks) renderBlocks(ctx, blocks, out);
    }
    renderThresholds(ctx, r, out);
    renderFindings(ctx, r.findings, report.failOn, opts.maxFindings ?? 50, out);
    if (r.limitations.length > 0) {
      out.push(c.bold("Limitations"));
      for (const l of r.limitations) {
        const tag = l.impact === "invalidates" ? c.red(l.impact) : l.impact === "reduces-confidence" ? c.yellow(l.impact) : c.dim(l.impact);
        out.push(`  ${ctx.sym.bullet} ${l.message} ${c.dim(`[${l.code}]`)} ${tag}`);
      }
    }
    if (r.artifacts.length > 0) {
      out.push(c.dim(`artifacts: ${r.artifacts.map((a) => a.path).join(", ")}`));
    }
  }
  const text = `${out.join("\n")}\n`;
  return ascii ? asciiFold(text) : text;
}
