/**
 * Threshold (SLO) evaluation against Performance Lab metrics, producing `threshold-breach` findings.
 * Grammar/parsing is sw-core's (docs/08-configuration.md §4); this module resolves metric values.
 * Latency stats use the CO-corrected histogram (docs/03-engines/performance-lab.md §2, §4).
 */
import { createHash } from "node:crypto";
import {
  evaluateThreshold,
  parseThresholds,
  type ThresholdEntry,
  type ThresholdSpec,
} from "../../core/config/thresholds.js";
import type { Evidence, Finding, Severity } from "../../core/evidence/schemas.js";
import type { LatencyHistogram } from "../../shared/stats/hdr.js";
import type { PerfMetrics } from "./metrics.js";

export interface ScopeView {
  latency: LatencyHistogram;
  requests: number;
  ok: number;
  failed: number;
  timeouts: number;
  /** Measured window length in seconds (for rps). */
  windowSec: number;
}

export interface ThresholdResult {
  expression: string;
  metric: string;
  op: string;
  /** Threshold value in normalised units (ms, 0..1, per s, count). */
  threshold: number;
  unit: string;
  /** Observed value in the same units; null when the metric has no data. */
  actual: number | null;
  passed: boolean;
  abortOnFail: boolean;
  /** True when this threshold triggered an early abort. */
  aborted?: boolean;
  reason?: string;
}

export function parseInputThresholds(record: Record<string, unknown>): ThresholdEntry[] {
  return parseThresholds(record as Record<string, ThresholdSpec>);
}

/** Builds the scope resolver over live metrics. */
export function scopeResolver(m: PerfMetrics, windowSec: number): (scope: string) => ScopeView | undefined {
  return (scope) => {
    if (scope === "http") {
      return {
        latency: m.global.corrected,
        requests: m.requests,
        ok: m.ok,
        failed: m.failed,
        timeouts: m.timeouts,
        windowSec,
      };
    }
    if (scope.startsWith("scenario.")) {
      const s = m.scenarios.get(scope.slice(9));
      if (!s) return undefined;
      // Scenario latency = iteration duration; rates are per request of that scenario.
      return {
        latency: s.latency.corrected,
        requests: s.requests,
        ok: s.ok,
        failed: s.failed,
        timeouts: s.timeouts,
        windowSec,
      };
    }
    if (scope.startsWith("endpoint.")) {
      const key = scope.slice(9);
      const e = m.endpoints.get(key);
      if (!e) return undefined;
      return {
        latency: e.latency.corrected,
        requests: e.requests,
        ok: e.ok,
        failed: e.failed,
        timeouts: e.timeouts,
        windowSec,
      };
    }
    return undefined;
  };
}

/** Value of a stat in normalised units, or null when there is no data. */
export function statValue(t: Pick<ThresholdEntry, "stat" | "percentile">, v: ScopeView): number | null {
  const lat = v.latency;
  const ms = (us: number): number => us / 1000;
  if (t.percentile !== undefined) return lat.count === 0 ? null : ms(lat.percentile(t.percentile));
  switch (t.stat) {
    case "avg":
      return lat.count === 0 ? null : ms(lat.mean);
    case "max":
      return lat.count === 0 ? null : ms(lat.max);
    case "min":
      return lat.count === 0 ? null : ms(lat.min);
    case "med":
      return lat.count === 0 ? null : ms(lat.percentile(50));
    case "rps":
      return v.windowSec > 0 ? v.requests / v.windowSec : null;
    case "error_rate":
      return v.requests === 0 ? null : v.failed / v.requests;
    case "timeout_rate":
      return v.requests === 0 ? null : v.timeouts / v.requests;
    case "success_rate":
    case "check_rate":
      return v.requests === 0 ? null : v.ok / v.requests;
    case "count":
    case "requests":
      return v.requests;
    case "errors":
      return v.failed;
    case "timeouts":
      return v.timeouts;
    default:
      return null;
  }
}

export function evaluateThresholds(
  entries: readonly ThresholdEntry[],
  resolve: (scope: string) => ScopeView | undefined,
): ThresholdResult[] {
  return entries.map((t) => {
    const view = resolve(t.scope);
    const actual = view ? statValue(t, view) : null;
    const base: ThresholdResult = {
      expression: t.source,
      metric: t.metric,
      op: t.op,
      threshold: t.value,
      unit: t.unit ?? "count",
      actual: actual === null ? null : Math.round(actual * 1e6) / 1e6,
      passed: actual !== null && evaluateThreshold(t, actual),
      abortOnFail: t.abortOnFail,
    };
    if (actual === null) base.reason = view ? "no data for this statistic" : `no data for scope "${t.scope}"`;
    return base;
  });
}

function unitLabel(unit: string): string {
  switch (unit) {
    case "ms":
      return "ms";
    case "ratio":
      return "ratio";
    case "per_s":
      return "req/s";
    default:
      return "count";
  }
}

export interface FindingContext {
  newId(): string;
  isoNow(): string;
  runId: string;
  target: string;
  window?: { start: string; end: string };
  /** Lowered when the generator was saturated. */
  confidence: number;
  seed?: number | undefined;
  severity?: Severity;
}

/** Turns failed thresholds into `threshold-breach` findings. */
export function thresholdFindings(results: readonly ThresholdResult[], fc: FindingContext): Finding[] {
  const out: Finding[] = [];
  for (const r of results) {
    if (r.passed) continue;
    const now = fc.isoNow();
    const evidence: Evidence[] = [
      { kind: "threshold", expression: r.expression, actual: r.actual ?? 0, passed: false },
    ];
    if (r.actual !== null) {
      const m: Evidence = {
        kind: "measurement",
        metric: r.metric,
        value: r.actual,
        unit: unitLabel(r.unit),
        runId: fc.runId,
      };
      if (fc.window) m.window = fc.window;
      evidence.push(m);
    } else {
      evidence.push({ kind: "note", text: r.reason ?? "metric had no data" });
    }
    const fingerprint = createHash("sha256")
      .update(`performance|threshold|${fc.target}|${r.metric}|${r.op}`)
      .digest("hex")
      .slice(0, 32);
    const actualText = r.actual === null ? "no data" : `${r.actual} ${unitLabel(r.unit)}`;
    const reproduction: Finding["reproduction"] = {
      steps: [
        `Run the Performance Lab against ${fc.target} with the same configuration`,
        `Check threshold "${r.expression}"`,
      ],
      artifacts: [],
    };
    if (fc.seed !== undefined) reproduction.seed = fc.seed;
    out.push({
      schemaVersion: 1,
      id: fc.newId(),
      fingerprint,
      engine: "performance",
      ruleId: "PERF-THRESHOLD",
      category: "performance",
      title: `Threshold breached: ${r.expression}`.slice(0, 200),
      description: `Threshold "${r.expression}" failed: observed ${actualText}, required ${r.op} ${r.threshold} ${unitLabel(r.unit)}.${r.aborted ? " The run was aborted early (abortOnFail)." : ""}`,
      severity: fc.severity ?? "high",
      classification: "threshold-breach",
      status: "open",
      confidence: fc.confidence,
      evidence,
      locations: [],
      affected: [r.metric],
      reproduction,
      recommendation:
        "Investigate the slowest endpoints and error samples in the report; compare with the baseline run.",
      related: [],
      occurrences: 1,
      firstSeen: now,
      lastSeen: now,
      tags: ["threshold", r.metric],
    });
  }
  return out;
}
