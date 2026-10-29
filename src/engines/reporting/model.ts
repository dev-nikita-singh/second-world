/**
 * Report model: combine EngineResults into one canonical, schema-versioned report,
 * order findings, decide the verdict. docs/03-engines/evidence-and-history.md §A.4–A.6.
 *
 * Pure functions: no I/O, no clock. Durations come from the results' own timestamps.
 */
import { ExitCode } from "../../core/errors.js";
import type { Classification, EngineResult, Finding, Severity } from "../../core/evidence/schemas.js";
import type { PerformanceData, ThresholdResult } from "../performance/types.js";

export type ReportFormat = "tty" | "json" | "md" | "junit" | "sarif" | "html";
export const REPORT_FORMATS: readonly ReportFormat[] = ["tty", "json", "md", "junit", "sarif", "html"];

export type FailOn = "critical" | "high" | "medium" | "low" | "never";
export const DEFAULT_FAIL_ON: FailOn = "high";

export interface ReportMeta {
  runId?: string;
  toolVersion?: string;
  configHash?: string;
  environment?: Record<string, unknown>;
  /** The command line that produced the report, for the reproduction appendix. */
  command?: string;
}

export interface Verdict {
  passed: boolean;
  exitCode: ExitCode;
  /** Human-readable reasons, deterministic order. */
  reasons: string[];
}

export interface CombinedReport {
  schemaVersion: 1;
  kind: "second-world-report";
  runId: string;
  toolVersion: string;
  configHash?: string;
  environment?: Record<string, unknown>;
  command?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: EngineResult["status"];
  failOn: FailOn;
  verdict: Verdict;
  results: EngineResult[];
}

/** Trust ladder, strongest first (report ordering, §A.4 item 4). */
export const CLASSIFICATION_ORDER: readonly Classification[] = [
  "verified-fix",
  "reproduced-defect",
  "threshold-breach",
  "observation",
  "suspected-risk",
  "hypothesis",
];
export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

const sevRank = (s: Severity): number => SEVERITY_ORDER.indexOf(s);
const clsRank = (c: Classification): number => CLASSIFICATION_ORDER.indexOf(c);

/** Findings grouped by classification (strongest first), then severity, then title/id (deterministic). */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      clsRank(a.classification) - clsRank(b.classification) ||
      sevRank(a.severity) - sevRank(b.severity) ||
      (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Runtime guard for the Performance Lab payload (data is `unknown` at the boundary). */
export function isPerformanceData(d: unknown): d is PerformanceData {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o.totals === "object" &&
    o.totals !== null &&
    typeof o.latency === "object" &&
    o.latency !== null &&
    Array.isArray(o.endpoints) &&
    Array.isArray(o.thresholds)
  );
}

/** Threshold results carried by an EngineResult's data (performance today), else []. */
export function thresholdsOf(r: EngineResult): ThresholdResult[] {
  const d = r.data as { thresholds?: unknown } | undefined;
  if (!d || !Array.isArray(d.thresholds)) return [];
  return d.thresholds.filter(
    (t): t is ThresholdResult => typeof t === "object" && t !== null && typeof (t as ThresholdResult).expression === "string",
  );
}

const ACTIVE_STATUSES = new Set(["open", "acknowledged"]);

/**
 * Does this finding make the run fail at `failOn`? Threshold breaches always count
 * (unless failOn = never). Other findings count when open/acknowledged, not mere
 * hypotheses, not verified fixes, and severity ≥ failOn.
 */
export function isFailingFinding(f: Finding, failOn: FailOn): boolean {
  if (failOn === "never") return false;
  if (!ACTIVE_STATUSES.has(f.status)) return false;
  if (f.classification === "threshold-breach") return true;
  if (f.classification === "hypothesis" || f.classification === "verified-fix") return false;
  return sevRank(f.severity) <= sevRank(failOn);
}

/** Limitation codes meaning the run failed because of the target, not the engine (→ exit 5). */
const TARGET_LIMITATIONS = new Set(["target-unreachable", "no-measurements"]);

/** Compute verdict + exit code (§A.6). Precedence: 130 cancelled > 70 error (5 when caused by the target) > 1 failures > 0. */
export function computeVerdict(results: readonly EngineResult[], failOn: FailOn = DEFAULT_FAIL_ON): Verdict {
  const reasons: string[] = [];
  const cancelled = results.filter((r) => r.status === "cancelled");
  const errored = results.filter((r) => r.status === "error");
  if (cancelled.length > 0) {
    reasons.push(`cancelled: ${cancelled.map((r) => r.engine).join(", ")} (partial results)`);
    return { passed: false, exitCode: ExitCode.Cancelled, reasons };
  }
  if (errored.length > 0) {
    // An error caused by the target (nothing answered / nothing measured) is exit 5, not a bug in SECOND WORLD.
    const targetSide = errored.filter((r) =>
      r.limitations.some((l) => l.impact === "invalidates" && TARGET_LIMITATIONS.has(l.code)),
    );
    if (targetSide.length === errored.length) {
      reasons.push(`target unreachable / nothing measured: ${errored.map((r) => r.engine).join(", ")}`);
      return { passed: false, exitCode: ExitCode.TargetUnreachable, reasons };
    }
    reasons.push(`engine error: ${errored.map((r) => r.engine).join(", ")}`);
    return { passed: false, exitCode: ExitCode.Internal, reasons };
  }
  if (failOn !== "never") {
    let breached = 0;
    for (const r of results) breached += thresholdsOf(r).filter((t) => !t.passed).length;
    const failing = results.flatMap((r) => r.findings).filter((f) => isFailingFinding(f, failOn));
    const breachFindings = failing.filter((f) => f.classification === "threshold-breach").length;
    const defects = failing.length - breachFindings;
    const nBreaches = Math.max(breached, breachFindings);
    if (nBreaches > 0) reasons.push(`${nBreaches} threshold(s) breached`);
    if (defects > 0) reasons.push(`${defects} finding(s) at or above severity '${failOn}'`);
    const failedStatus = results.filter((r) => r.status === "failed");
    if (reasons.length === 0 && failedStatus.length > 0) {
      reasons.push(`engine reported failure: ${failedStatus.map((r) => r.engine).join(", ")}`);
    }
    if (reasons.length > 0) return { passed: false, exitCode: ExitCode.Failures, reasons };
  }
  const partial = results.filter((r) => r.status === "partial");
  if (partial.length > 0) reasons.push(`partial results: ${partial.map((r) => r.engine).join(", ")}`);
  reasons.unshift(
    failOn === "never" ? "completed (--fail-on never)" : `completed: no failing thresholds or findings at or above '${failOn}'`,
  );
  return { passed: true, exitCode: ExitCode.Ok, reasons };
}

const STATUS_PRECEDENCE: readonly EngineResult["status"][] = ["error", "cancelled", "failed", "partial", "passed", "skipped"];

function overallStatus(results: readonly EngineResult[]): EngineResult["status"] {
  for (const s of STATUS_PRECEDENCE) if (results.some((r) => r.status === s)) return s;
  return "skipped";
}

function minIso(xs: string[]): string {
  return xs.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
}
function maxIso(xs: string[]): string {
  return xs.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

/** Combine engine results into the canonical report (§A.4). */
export function combineResults(
  results: readonly EngineResult[],
  meta: ReportMeta = {},
  failOn: FailOn = DEFAULT_FAIL_ON,
): CombinedReport {
  const list = [...results];
  const starts = list.map((r) => r.startedAt).filter((s) => !Number.isNaN(Date.parse(s)));
  const ends = list.map((r) => r.endedAt).filter((s) => !Number.isNaN(Date.parse(s)));
  const startedAt = starts.length > 0 ? minIso(starts) : "";
  const endedAt = ends.length > 0 ? maxIso(ends) : startedAt;
  const durationMs = startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : 0;
  const report: CombinedReport = {
    schemaVersion: 1,
    kind: "second-world-report",
    runId: meta.runId ?? list[0]?.runId ?? "unknown",
    toolVersion: meta.toolVersion ?? "unknown",
    startedAt,
    endedAt,
    durationMs,
    status: overallStatus(list),
    failOn,
    verdict: computeVerdict(list, failOn),
    results: list,
  };
  if (meta.configHash !== undefined) report.configHash = meta.configHash;
  if (meta.environment !== undefined) report.environment = meta.environment;
  if (meta.command !== undefined) report.command = meta.command;
  return report;
}

export function isCombinedReport(x: unknown): x is CombinedReport {
  return typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "second-world-report";
}

/** Normalise any accepted input into a CombinedReport. */
export function toReport(
  input: EngineResult | readonly EngineResult[] | CombinedReport,
  meta?: ReportMeta,
  failOn?: FailOn,
): CombinedReport {
  if (isCombinedReport(input)) {
    if (failOn === undefined || failOn === input.failOn) return input;
    return { ...input, failOn, verdict: computeVerdict(input.results, failOn) };
  }
  const list: readonly EngineResult[] = Array.isArray(input) ? input : [input as EngineResult];
  return combineResults(list, meta, failOn);
}

/** Format milliseconds compactly and deterministically: 950ms, 12.3s, 2m05s. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/** Latency in ms with sensible precision. */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms >= 100) return `${ms.toFixed(0)}ms`;
  if (ms >= 10) return `${ms.toFixed(1)}ms`;
  return `${ms.toFixed(2)}ms`;
}

export function fmtPct(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  return `${(x * 100).toFixed(x > 0 && x < 0.001 ? 3 : 2)}%`;
}

export function fmtNum(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  return Number.isInteger(x) ? String(x) : x.toFixed(digits);
}

/** Render a threshold's actual value in its unit. */
export function fmtThresholdValue(v: number | null, unit: string): string {
  if (v === null) return "n/a";
  if (unit === "ms") return fmtMs(v);
  if (unit === "ratio" || unit === "%" || unit === "rate") return fmtPct(v);
  if (unit === "per_s") return `${fmtNum(v, 1)} req/s`;
  return `${fmtNum(v, 2)}${unit && unit !== "count" ? ` ${unit}` : ""}`;
}

export function locationOf(f: Finding): string {
  const l = f.locations[0];
  if (l) return `${l.file}:${l.line}${l.column ? `:${l.column}` : ""}`;
  return f.affected[0] ?? "";
}
