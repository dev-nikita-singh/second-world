/**
 * Format-neutral report blocks for engine payloads that tty / markdown / html all render:
 * StressData (docs/03-engines/stress-capacity-lab.md §4, §6 honesty rules), RunComparison
 * (docs/03-engines/evidence-and-history.md Part B), and PerformanceData (html only;
 * tty/markdown have hand-tuned perf layouts).
 *
 * Honesty rules encoded here:
 *  - capacity is always "tested capacity" and `capacity.statement` is shown verbatim;
 *  - the USL fit is an *estimate*, rendered in its own clearly labelled section;
 *  - single-run comparisons show movement only, with "no statistics", never a verdict.
 */
import type { MetricComparison, RunComparison } from "../history/types.js";
import type { PerformanceData } from "../performance/types.js";
import type { StageResult, StressData } from "../stress/types.js";
import { fmtDuration, fmtMs, fmtNum, fmtPct } from "./model.js";

export type Tone = "good" | "bad" | "warn" | "muted";
export interface Cell {
  text: string;
  tone?: Tone;
}
export type CellLike = string | Cell;

export type Block =
  | { kind: "heading"; text: string; level: 2 | 3 }
  | { kind: "kv"; items: [string, CellLike][] }
  | { kind: "table"; title?: string; head: string[]; rows: CellLike[][]; align?: ("l" | "r")[] }
  | { kind: "text"; text: string; tone?: Tone }
  | {
      kind: "quote";
      title: string;
      text: string /** Shown instead of `text` in ASCII-only terminals. */;
      ascii?: string;
    }
  | {
      kind: "spark";
      title: string;
      values: number[];
      labels?: string[];
      unit: string;
      /** Highlighted index range [from, to) — e.g. the fault window. */
      mark?: { from: number; to: number; label: string };
    }
  /** Shell commands, shown verbatim (monospace / fenced). */
  | { kind: "code"; title: string; lines: string[]; lang?: string };

export const cellText = (c: CellLike): string => (typeof c === "string" ? c : c.text);
export const cellTone = (c: CellLike): Tone | undefined => (typeof c === "string" ? undefined : c.tone);

// ---------------------------------------------------------------- guards

export function isStressData(d: unknown): d is StressData {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    Array.isArray(o.stages) &&
    typeof o.mode === "string" &&
    typeof o.capacity === "object" &&
    o.capacity !== null &&
    typeof (o.capacity as { statement?: unknown }).statement === "string" &&
    typeof o.curves === "object" &&
    o.curves !== null
  );
}

export function isRunComparison(d: unknown): d is RunComparison {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  const f = o.findings as Record<string, unknown> | undefined;
  return (
    Array.isArray(o.baselineIds) &&
    Array.isArray(o.currentIds) &&
    Array.isArray(o.metrics) &&
    typeof f === "object" &&
    f !== null &&
    Array.isArray(f.new) &&
    Array.isArray(f.fixed) &&
    Array.isArray(f.regressed) &&
    Array.isArray(f.unchanged)
  );
}

// ---------------------------------------------------------------- helpers

/** Generic metric value: compact, deterministic. */
export function fmtVal(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  const a = Math.abs(x);
  if (a === 0) return "0";
  if (a >= 1000) return x.toFixed(0);
  if (a >= 100) return x.toFixed(1);
  if (a >= 1) return x.toFixed(2);
  return x.toPrecision(3);
}

function fmtSigned(x: number, suffix = ""): string {
  return `${x > 0 ? "+" : ""}${fmtVal(x)}${suffix}`;
}

function levelText(d: StressData, level: number): string {
  return d.loadType === "vus" ? `${fmtNum(level, 0)} VUs` : `${fmtNum(level, 1)}/s`;
}

function stageStatusCell(s: StageResult): Cell {
  if (s.status === "passed") return { text: "passed", tone: "good" };
  if (s.status === "breached") return { text: "breached", tone: "bad" };
  if (s.status === "error") return { text: "error", tone: "bad" };
  return { text: s.status, tone: "warn" };
}

// ---------------------------------------------------------------- stress

export function stressBlocks(d: StressData): Block[] {
  const b: Block[] = [];
  const kv: [string, CellLike][] = [
    ["mode", d.mode],
    ["load type", d.loadType === "vus" ? "virtual users (closed)" : "arrival rate (open)"],
    ["target", d.target],
    ["stop reason", d.stopDetail ? `${d.stopReason} (${d.stopDetail})` : d.stopReason],
  ];
  b.push({ kind: "kv", items: kv });

  b.push({ kind: "quote", title: "Capacity", text: d.capacity.statement });
  b.push({
    kind: "kv",
    items: [
      [
        "tested capacity",
        d.capacity.testedCapacity === null
          ? { text: "none (no stage met the requirements)", tone: "bad" }
          : levelText(d, d.capacity.testedCapacity),
      ],
    ],
  });

  if (d.invalidFromStage !== null) {
    b.push({
      kind: "text",
      tone: "warn",
      text: `Load generator saturated from stage ${d.invalidFromStage}: results from that stage on are invalid and excluded from conclusions.`,
    });
  }

  b.push({
    kind: "table",
    title: "Stages",
    head: [
      "#",
      "level",
      "status",
      "throughput",
      "p50",
      "p95",
      "p99",
      "error rate",
      "breach reasons",
      "invalid",
    ],
    align: ["r", "r", "l", "r", "r", "r", "r", "r", "l", "l"],
    rows: d.stages.map((s) => [
      String(s.index),
      levelText(d, s.level),
      stageStatusCell(s),
      `${fmtNum(s.throughput, 1)}/s`,
      fmtMs(s.latency.p50),
      fmtMs(s.latency.p95),
      fmtMs(s.latency.p99),
      s.errorRate > 0 ? { text: fmtPct(s.errorRate), tone: "bad" } : fmtPct(s.errorRate),
      s.breachReasons.join("; "),
      // sw-stress: "CAPPED" = throttled by the safety rate cap (throughput reflects the cap, not the target).
      s.invalid || s.capped
        ? {
            text: [s.invalid ? "INVALID" : "", s.capped ? "CAPPED" : ""].filter(Boolean).join(", "),
            tone: "warn",
          }
        : "",
    ]),
  });
  if (d.safetyCap) {
    const sc = d.safetyCap;
    b.push({
      kind: "text",
      tone: "warn",
      text: `CAPPED: stage(s) ${sc.cappedStages.join(", ")} were throttled by the safety rate cap${sc.rps !== null ? ` (${fmtNum(sc.rps, 0)} req/s)` : ""}; their throughput reflects the cap, not the target${sc.impact === "invalidates" ? ", so the capacity statement does not describe the target" : ""}.`,
    });
  }
  for (const note of d.notes ?? []) b.push({ kind: "text", tone: "warn", text: note });

  const key: [string, CellLike][] = [];
  const fb = d.firstBreach;
  key.push([
    "first breach",
    fb
      ? {
          text: `stage ${fb.stageIndex} at ${levelText(d, fb.level)}: ${fb.expression}${fb.actual !== null ? ` (actual ${fmtVal(fb.actual)})` : ""}`,
          tone: "bad",
        }
      : "none",
  ]);
  key.push([
    "knee",
    d.knee
      ? `stage ${d.knee.stageIndex} at ${levelText(d, d.knee.level)} (p95 ${fmtMs(d.knee.p95)}, strength ${fmtVal(d.knee.strength)})`
      : "none detected",
  ]);
  if (d.breakpoint) {
    const bp = d.breakpoint;
    key.push([
      "breakpoint",
      `last pass ${bp.lastPass === null ? "-" : levelText(d, bp.lastPass)}, first fail ${bp.firstFail === null ? "-" : levelText(d, bp.firstFail)}, ${bp.converged ? `converged (min step ${fmtVal(bp.minStep)})` : "not converged"}, ${bp.bisectionStages} bisection stage(s)`,
    ]);
  }
  if (d.spike) {
    const sp = d.spike;
    key.push([
      "spike recovery",
      sp.recovered && sp.recoveryTimeS !== null
        ? {
            text: `${fmtVal(sp.recoveryTimeS)} s back to baseline p95 ±${fmtMs(sp.toleranceMs)}`,
            tone: "good",
          }
        : { text: "not recovered", tone: "bad" },
    ]);
    key.push(["spike p95", `baseline ${fmtMs(sp.baselineP95)} → peak ${fmtMs(sp.peakP95)}`]);
  }
  if (d.soak) {
    const sk = d.soak;
    key.push([
      "soak drift",
      sk.drift
        ? {
            text: `drift detected: p95 ${sk.p95SlopeMsPerHour === null ? "-" : fmtSigned(sk.p95SlopeMsPerHour, " ms/h")}`,
            tone: "bad",
          }
        : {
            text: `no drift (p95 slope ${sk.p95SlopeMsPerHour === null ? "-" : fmtSigned(sk.p95SlopeMsPerHour, " ms/h")})`,
            tone: "good",
          },
    ]);
    if (sk.ci95) key.push(["soak slope ci95", `[${fmtVal(sk.ci95[0])}, ${fmtVal(sk.ci95[1])}] ms/h`]);
    if (sk.changePoints.length > 0)
      key.push(["change points", sk.changePoints.map((c) => `${fmtVal(c.t)}s ${c.direction}`).join(", ")]);
  }
  b.push({ kind: "kv", items: key });

  if (d.curves.level.length >= 2) {
    b.push({
      kind: "spark",
      title: "p95 by load level",
      values: d.curves.p95,
      labels: d.curves.level.map((l) => levelText(d, l)),
      unit: "ms",
    });
  }

  if (d.usl) {
    const u = d.usl;
    b.push({ kind: "heading", level: 3, text: "Estimates (model fit, not measured)" });
    if (u.refused) {
      b.push({ kind: "text", tone: "muted", text: `USL estimate refused: ${u.refused}` });
    } else {
      b.push({
        kind: "kv",
        items: [
          ["model", "Universal Scalability Law X(N) = λN / (1 + σ(N−1) + κN(N−1))"],
          ["λ (single-unit throughput)", fmtVal(u.lambda)],
          ["σ (contention)", fmtVal(u.sigma)],
          ["κ (coherency)", fmtVal(u.kappa)],
          ["fit r²", fmtVal(u.r2)],
          ["estimated peak N*", u.peakN === null ? "none (κ = 0)" : fmtVal(u.peakN)],
          ["estimated peak throughput", u.peakThroughput === null ? "-" : `${fmtVal(u.peakThroughput)}/s`],
          ["basis", `${u.basis}, ${u.points} point(s)`],
        ],
      });
      if (u.extrapolated) {
        b.push({
          kind: "text",
          tone: "warn",
          text: "N* lies beyond the tested range: extrapolated, treat as a rough estimate only.",
        });
      }
    }
  }
  return b;
}

// ---------------------------------------------------------------- history comparison

function metricRow(m: MetricComparison): CellLike[] {
  const pct = m.relativeChange * 100;
  const change = Number.isFinite(pct) ? `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%` : "-";
  if (m.method === "single-run") {
    const mv = m.movement ?? "within-threshold";
    return [
      m.metric,
      "single-run",
      fmtVal(m.baseline),
      fmtVal(m.current),
      change,
      { text: `${mv} (no statistics)`, tone: mv === "worse" ? "bad" : mv === "better" ? "good" : "muted" },
      "-",
      "-",
    ];
  }
  const tone: Tone | undefined =
    m.verdict === "regressed" ? "bad" : m.verdict === "improved" ? "good" : "muted";
  return [
    m.metric,
    "statistical",
    fmtVal(m.baseline),
    fmtVal(m.current),
    change,
    { text: m.verdict, ...(tone ? { tone } : {}) },
    m.ci95 ? `[${fmtVal(m.ci95[0])}, ${fmtVal(m.ci95[1])}]` : "-",
    m.pAdjusted !== undefined ? fmtVal(m.pAdjusted) : m.p !== undefined ? `${fmtVal(m.p)} (unadj.)` : "-",
  ];
}

export function comparisonBlocks(c: RunComparison): Block[] {
  const b: Block[] = [];
  b.push({
    kind: "kv",
    items: [
      ["baseline", c.baselineIds.join(", ")],
      ["current", c.currentIds.join(", ")],
      ["method", c.method],
    ],
  });
  if (c.summary) b.push({ kind: "text", text: c.summary });
  if (c.method !== "statistical" && c.metrics.some((m) => m.method === "single-run")) {
    b.push({
      kind: "text",
      tone: "muted",
      text: "Single-run metrics: one value per side, no statistics. Movement beyond the change threshold is shown, not significance.",
    });
  }
  if (c.metrics.length > 0) {
    b.push({
      kind: "table",
      title: "Metrics",
      head: ["metric", "method", "baseline", "current", "change", "verdict / movement", "ci95", "p (adj.)"],
      align: ["l", "l", "r", "r", "r", "l", "r", "r"],
      rows: c.metrics.map(metricRow),
    });
    const notes = c.metrics.filter((m) => m.note).map((m) => `${m.metric}: ${m.note}`);
    if (notes.length > 0) b.push({ kind: "text", tone: "muted", text: notes.join(" · ") });
  }
  const f = c.findings;
  b.push({
    kind: "kv",
    items: [
      ["findings new", f.new.length > 0 ? { text: String(f.new.length), tone: "bad" } : "0"],
      [
        "findings regressed",
        f.regressed.length > 0 ? { text: String(f.regressed.length), tone: "bad" } : "0",
      ],
      ["findings fixed", f.fixed.length > 0 ? { text: String(f.fixed.length), tone: "good" } : "0"],
      ["findings unchanged", String(f.unchanged.length)],
    ],
  });
  const rows: CellLike[][] = [];
  const add = (status: "new" | "regressed" | "fixed" | "unchanged", tone: Tone | undefined) => {
    for (const e of f[status])
      rows.push([tone ? { text: status, tone } : status, e.severity, e.engine, e.title]);
  };
  add("new", "bad");
  add("regressed", "bad");
  add("fixed", "good");
  add("unchanged", undefined);
  if (rows.length > 0)
    b.push({
      kind: "table",
      title: "Finding changes",
      head: ["status", "severity", "engine", "finding"],
      rows,
    });
  if (c.regressions.length > 0)
    b.push({ kind: "text", tone: "bad", text: `Regressions: ${c.regressions.join("; ")}` });
  return b;
}

// ---------------------------------------------------------------- performance (html)

export function perfBlocks(d: PerformanceData): Block[] {
  const t = d.totals;
  const L = d.latency;
  const b: Block[] = [];
  b.push({
    kind: "kv",
    items: [
      ["target", d.target],
      ["model", d.arrival ? `${d.model} / ${d.arrival}` : d.model],
      ["measured window", fmtDuration(d.window.measuredMs)],
      ["stop reason", d.window.stopReason],
      ...(t.targetRate !== undefined && t.achievedRate !== undefined
        ? ([["rate", `target ${fmtNum(t.targetRate)}/s, achieved ${fmtNum(t.achievedRate)}/s`]] as [
            string,
            CellLike,
          ][])
        : []),
    ],
  });
  b.push({
    kind: "table",
    title: "Summary",
    head: ["", "requests", "rps", "error rate", "p50", "p95", "p99", "max"],
    align: ["l", "r", "r", "r", "r", "r", "r", "r"],
    rows: [
      [
        "corrected",
        String(t.requests),
        fmtNum(t.rps),
        t.errorRate > 0 ? { text: fmtPct(t.errorRate), tone: "bad" } : fmtPct(t.errorRate),
        fmtMs(L.corrected.p50),
        fmtMs(L.corrected.p95),
        fmtMs(L.corrected.p99),
        fmtMs(L.corrected.max),
      ],
      [
        { text: "raw (uncorrected)", tone: "muted" },
        "",
        "",
        "",
        fmtMs(L.raw.p50),
        fmtMs(L.raw.p95),
        fmtMs(L.raw.p99),
        fmtMs(L.raw.max),
      ],
    ],
  });
  if (d.endpoints.length > 0) {
    b.push({
      kind: "table",
      title: "Endpoints",
      head: ["endpoint", "requests", "rps", "errors", "p50", "p95", "p99"],
      align: ["l", "r", "r", "r", "r", "r", "r"],
      rows: [...d.endpoints]
        .sort((a, z) => (a.key < z.key ? -1 : a.key > z.key ? 1 : 0))
        .map((e) => [
          e.key,
          String(e.requests),
          fmtNum(e.rps),
          e.errorRate > 0 ? { text: fmtPct(e.errorRate), tone: "bad" } : fmtPct(e.errorRate),
          fmtMs(e.latency.corrected.p50),
          fmtMs(e.latency.corrected.p95),
          fmtMs(e.latency.corrected.p99),
        ]),
    });
  }
  if (d.series.length >= 2) {
    b.push({
      kind: "spark",
      title: "p95 over time (1 s windows)",
      values: d.series.map((p) => p.p95),
      labels: d.series.map((p) => `${p.t}s`),
      unit: "ms",
    });
    b.push({
      kind: "spark",
      title: "throughput over time",
      values: d.series.map((p) => p.rps),
      labels: d.series.map((p) => `${p.t}s`),
      unit: "req/s",
    });
  }
  if (d.errors.length > 0) {
    b.push({
      kind: "table",
      title: "Errors",
      head: ["kind", "count"],
      align: ["l", "r"],
      rows: d.errors.map((e) => [perfErrorKindLabel(d, e.kind), String(e.count)]),
    });
  }
  const g = d.generator;
  b.push({
    kind: "text",
    tone: g.saturated ? "warn" : "muted",
    text: `Generator: event-loop p99 ${fmtMs(g.eventLoopDelayP99Ms)}, cpu ${fmtNum(g.cpuPercent, 0)}%, scheduling lag p99 ${fmtMs(g.schedulingLagP99Ms)}${(g.workers ?? 1) > 1 ? `, workers ${g.workers}` : ""}${g.saturated ? ` — SATURATED: ${(g.reasons ?? []).join("; ")}` : ""}`,
  });
  return b;
}

/**
 * Min and max of the finite values, in one loop (no `Math.min(...xs)`: spreading a long per-tick
 * series overflows the call stack above ~120k points). null when there is no finite value.
 */
export function finiteRange(values: readonly number[]): { lo: number; hi: number } | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? { lo, hi } : null;
}

/**
 * Display label of a Performance Lab error kind. "status" (unexpected HTTP status) names the codes
 * seen in the error samples, e.g. `status (HTTP 404, 500)`; other kinds are shown as they are.
 */
export function perfErrorKindLabel(
  d: Pick<PerformanceData, "errorSamples" | "firstErrors">,
  kind: string,
): string {
  if (kind !== "status") return kind;
  const codes = new Set<number>();
  for (const list of [d.firstErrors ?? [], d.errorSamples ?? []]) {
    for (const s of list) if (s.kind === "status" && s.status > 0) codes.add(s.status);
  }
  return codes.size > 0 ? `status (HTTP ${[...codes].sort((a, b) => a - b).join(", ")})` : kind;
}
