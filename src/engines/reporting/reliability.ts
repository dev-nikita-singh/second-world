/**
 * Reliability Lab rendering (docs/03-engines/reliability-lab.md §2–§3): scenario and injected
 * fault, experiment timeline (steady → fault → recovery) with per-second error-rate / p95
 * sparklines and the fault window marked, steady-state & hypothesis verdicts, recovery time,
 * detector results, duplicate-operation invariants (§3) with per-route logical operations,
 * rule hits across repetitions (k/n → reproduced-defect vs observation).
 * Limitations are rendered by the generic engine section.
 */
import type { Finding } from "../../core/evidence/schemas.js";
import type { PhaseStats } from "../reliability/detectors.js";
import type { ReliabilityData, RunAnalysis } from "../reliability/types.js";
import { type Block, type CellLike, fmtVal } from "./blocks.js";
import { fmtDuration, fmtMs, fmtNum, fmtPct } from "./model.js";

export function isReliabilityData(d: unknown): d is ReliabilityData {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o.scenario === "string" &&
    typeof o.dependency === "string" &&
    typeof o.injector === "string" &&
    Array.isArray(o.runs) &&
    Array.isArray(o.faults) &&
    typeof o.phases === "object" &&
    o.phases !== null &&
    (o.verdict === "held" || o.verdict === "violated" || o.verdict === "inconclusive")
  );
}

/** Detector → rule ids it can raise (for JUnit pass/fail per detector). */
export const DETECTOR_RULES: Record<DetectorName, string[]> = {
  "retry amplification": ["reliability/retry-without-backoff", "reliability/retry-storm"],
  "synchronised retries": ["reliability/retry-without-jitter"],
  "circuit breaker": ["reliability/no-circuit-breaker"],
  "timeout correctness": ["reliability/outbound-no-timeout", "reliability/timeout-mismatch"],
  isolation: ["reliability/isolation-failure"],
  recovery: ["reliability/slow-recovery"],
};
export type DetectorName =
  | "retry amplification"
  | "synchronised retries"
  | "circuit breaker"
  | "timeout correctness"
  | "isolation"
  | "recovery";
export const DETECTORS = Object.keys(DETECTOR_RULES) as DetectorName[];

export interface DetectorSummary {
  name: DetectorName;
  /** False when no run assessed it (not applicable to this scenario). */
  assessed: boolean;
  /** True when some run flagged a problem. */
  flagged: boolean;
  detail: string;
}


/** One summary per detector, across runs (first flagged run's detail wins). */
export function detectorSummaries(d: ReliabilityData): DetectorSummary[] {
  const out: DetectorSummary[] = [];
  const pick = <T>(get: (r: RunAnalysis) => T | null | undefined, flagged: (x: T) => boolean, detail: (x: T, r: RunAnalysis) => string, name: DetectorName) => {
    const vals = d.runs.map((r) => ({ r, x: get(r) })).filter((v): v is { r: RunAnalysis; x: T } => v.x !== null && v.x !== undefined);
    if (vals.length === 0) {
      out.push({ name, assessed: false, flagged: false, detail: "not assessed in this scenario" });
      return;
    }
    const bad = vals.find((v) => flagged(v.x));
    const shown = bad ?? vals[0]!;
    const runs = d.runs.length > 1 ? ` [run ${shown.r.index + 1}; flagged in ${vals.filter((v) => flagged(v.x)).length}/${vals.length}]` : "";
    out.push({ name, assessed: true, flagged: bad !== undefined, detail: `${detail(shown.x, shown.r)}${runs}` });
  };
  pick(
    (r) => r.amplification,
    (a) => a.storm || a.factor > 3,
    (a) =>
      `${fmtVal(a.factor)}x dependency calls per request (fault ${fmtVal(a.faultRatio)} vs steady ${a.steadyRatio === null ? "-" : fmtVal(a.steadyRatio)}; ${a.proxyRequests} calls / ${a.clientRequests} requests)${a.storm ? " — retry storm" : ""}`,
    "retry amplification",
  );
  pick(
    (r) => r.jitter,
    (j) => j.detected,
    (j) => `${j.detected ? "synchronised retries detected" : "no synchronised retries"}${j.lagMs !== null ? ` (lag ${fmtMs(j.lagMs)}, z ${fmtVal(j.z)})` : ""}: ${j.reason}`,
    "synchronised retries",
  );
  pick(
    (r) => r.breaker,
    (b) => b.verdict === "no-breaker",
    (b) =>
      `${b.verdict}: calls/request baseline ${b.baselineRatio === null ? "-" : fmtVal(b.baselineRatio)}, early ${b.earlyRatio === null ? "-" : fmtVal(b.earlyRatio)}, late ${b.lateRatio === null ? "-" : fmtVal(b.lateRatio)} — ${b.reason}`,
    "circuit breaker",
  );
  pick(
    (r) => r.timeout,
    (t) => t.verdict === "no-timeout",
    (t) =>
      `${t.verdict}: ${t.completedDuringFault}/${t.eligible} answered during the fault${t.effectiveTimeoutMs !== null ? `, effective timeout ≈ ${fmtMs(t.effectiveTimeoutMs)}` : ""} — ${t.reason}`,
    "timeout correctness",
  );
  pick(
    (r) => (r.isolation.length > 0 ? r.isolation : null),
    (iso) => iso.some((i) => i.isolationFailure),
    (iso) =>
      iso
        .map((i) => `${i.route}: ${i.isolationFailure ? "ISOLATION FAILURE" : i.degraded ? "degraded (expected, depends on it)" : "ok"}${i.related === null ? " (relation unknown)" : ""}`)
        .join("; "),
    "isolation",
  );
  pick(
    (r) => r.recovery,
    (rc) => !rc.recovered,
    (rc) =>
      rc.recovered && rc.recoveryMs !== null
        ? `recovered in ${fmtDuration(rc.recoveryMs)} (${rc.consecutive} windows within p95 ≤ ${fmtMs(rc.bounds.p95Ms)}, errors ≤ ${fmtPct(rc.bounds.errorRate)})`
        : `not recovered within the recovery phase (bounds p95 ≤ ${fmtMs(rc.bounds.p95Ms)}, errors ≤ ${fmtPct(rc.bounds.errorRate)})`,
    "recovery",
  );
  return out;
}

/** One row per invariant and run: name, type, held / VIOLATED / error, verdict detail (+ duplicated keys). */
export function invariantRows(d: ReliabilityData): CellLike[][] {
  const rows: CellLike[][] = [];
  for (const r of d.runs) {
    for (const x of r.invariants ?? []) {
      const dup = (x.duplicates ?? [])
        .slice(0, 3)
        .map((k) => `${k.key}×${k.count}${k.phase ? ` (${k.phase})` : ""}`)
        .join(", ");
      rows.push([
        d.runs.length > 1 ? `${x.name} (run ${r.index + 1})` : x.name,
        x.type,
        x.status === "held"
          ? { text: "held", tone: "good" }
          : x.status === "violated"
            ? { text: "VIOLATED", tone: "bad" }
            : { text: "error", tone: "warn" },
        dup ? `${x.detail}; e.g. ${dup}` : x.detail,
      ]);
    }
  }
  return rows;
}

export interface CheckSummary {
  phase: "steady" | "fault";
  expression: string;
  passed: boolean;
  actuals: { run: number; actual: number; passed: boolean }[];
}

/** Steady-state / hypothesis checks aggregated across runs (fails if any run failed). */
export function checkSummaries(d: ReliabilityData): CheckSummary[] {
  const map = new Map<string, CheckSummary>();
  for (const r of d.runs) {
    for (const c of r.checks) {
      const key = `${c.phase}|${c.expression}`;
      let s = map.get(key);
      if (!s) map.set(key, (s = { phase: c.phase, expression: c.expression, passed: true, actuals: [] }));
      s.actuals.push({ run: r.index, actual: c.actual, passed: c.passed });
      if (!c.passed) s.passed = false;
    }
  }
  return [...map.values()].sort((a, b) => (a.phase === b.phase ? 0 : a.phase === "steady" ? -1 : 1));
}

export const phaseLabel = (p: "steady" | "fault"): string => (p === "steady" ? "steady state" : "hypothesis (during fault)");

function phaseRow(name: string, ms: number, s: PhaseStats): CellLike[] {
  return [
    name,
    fmtDuration(ms),
    String(s.requests),
    s.errorRate > 0 ? { text: fmtPct(s.errorRate), tone: "bad" } : fmtPct(s.errorRate),
    s.timeouts > 0 ? { text: String(s.timeouts), tone: "warn" } : "0",
    fmtMs(Number.isFinite(s.p50) ? s.p50 : null),
    fmtMs(Number.isFinite(s.p95) ? s.p95 : null),
    fmtNum(s.rps, 1),
  ];
}

export function reliabilityBlocks(d: ReliabilityData, findings: readonly Finding[] = []): Block[] {
  const b: Block[] = [];
  b.push({
    kind: "kv",
    items: [
      ["scenario", d.scenario],
      ["fault", d.faults.length > 0 ? d.faults.join(" + ") : { text: "none applied", tone: "warn" }],
      ["dependency", d.dependency],
      ["injector", d.injector],
      ["environment", d.environment],
      ["workload", `${fmtNum(d.workload.rate, 1)} req/s ${d.workload.arrival} over ${d.workload.routes.join(", ")}`],
      ["repetitions", String(d.repeat)],
      [
        "verdict",
        d.verdict === "held"
          ? { text: "hypothesis held", tone: "good" }
          : d.verdict === "violated"
            ? { text: "hypothesis VIOLATED", tone: "bad" }
            : { text: "inconclusive (steady state not met or run cancelled)", tone: "warn" },
      ],
    ],
  });

  // ---- timeline
  b.push({ kind: "heading", level: 3, text: "Experiment timeline" });
  const first = d.runs[0];
  const timelineRows: CellLike[][] = [];
  for (const r of d.runs) {
    const tag = d.runs.length > 1 ? ` (run ${r.index + 1})` : "";
    timelineRows.push(phaseRow(`steady${tag}`, d.phases.steadyMs, r.steady));
    timelineRows.push(phaseRow(`fault${tag}`, r.fault.durationMs, r.during));
    timelineRows.push(phaseRow(`recovery${tag}`, d.phases.recoveryMs, r.recoveryPhase));
  }
  b.push({
    kind: "table",
    head: ["phase", "duration", "requests", "error rate", "timeouts", "p50", "p95", "rps"],
    align: ["l", "r", "r", "r", "r", "r", "r", "r"],
    rows: timelineRows,
  });
  for (const r of d.runs) {
    if (!r.fault.applied) b.push({ kind: "text", tone: "warn", text: `Run ${r.index + 1}: fault was not applied.` });
    if (r.fault.abortedEarly) b.push({ kind: "text", tone: "warn", text: `Run ${r.index + 1}: fault aborted early (${r.fault.abortedEarly}).` });
    if (!r.steadyOk) b.push({ kind: "text", tone: "warn", text: `Run ${r.index + 1}: steady state was not met before injection.` });
  }
  if (first && first.windows.length >= 2) {
    const w = first.windows;
    const from = w.findIndex((x) => x.tMs >= 0);
    let to = w.findIndex((x) => x.tMs >= first.fault.durationMs);
    if (to < 0) to = w.length;
    const mark = from >= 0 && to > from ? { from, to, label: `fault window (${fmtDuration(first.fault.durationMs)})` } : undefined;
    const runNote = d.runs.length > 1 ? ` (run 1 of ${d.runs.length})` : "";
    b.push({ kind: "spark", title: `error rate per second${runNote}`, values: w.map((x) => x.errorRate * 100), unit: "%", ...(mark ? { mark } : {}) });
    b.push({ kind: "spark", title: `p95 per second${runNote}`, values: w.map((x) => x.p95), unit: "ms", ...(mark ? { mark } : {}) });
  }

  // ---- verdicts
  const checks = checkSummaries(d);
  if (checks.length > 0) {
    b.push({
      kind: "table",
      title: "Steady state & hypothesis",
      head: ["condition", "threshold", "actual", "result"],
      align: ["l", "l", "r", "l"],
      rows: checks.map((c) => [
        phaseLabel(c.phase),
        c.expression,
        c.actuals.map((a) => fmtVal(a.actual)).join(" / "),
        c.passed ? { text: "held", tone: "good" } : { text: "VIOLATED", tone: "bad" },
      ]),
    });
  } else {
    b.push({ kind: "text", tone: "muted", text: "No steady-state or hypothesis thresholds were configured." });
  }

  // ---- recovery
  const rec = d.runs.map((r) => r.recovery).filter((x) => x !== null);
  if (rec.length > 0) {
    b.push({
      kind: "kv",
      items: d.runs.map((r): [string, CellLike] => [
        d.runs.length > 1 ? `recovery time (run ${r.index + 1})` : "recovery time",
        !r.recovery
          ? { text: "not measured", tone: "muted" }
          : r.recovery.recovered && r.recovery.recoveryMs !== null
            ? { text: fmtDuration(r.recovery.recoveryMs), tone: "good" }
            : { text: "not recovered", tone: "bad" },
      ]),
    });
  }

  // ---- detectors
  b.push({
    kind: "table",
    title: "Detectors",
    head: ["detector", "result", "details"],
    rows: detectorSummaries(d).map((s) => [
      s.name,
      !s.assessed ? { text: "n/a", tone: "muted" } : s.flagged ? { text: "FLAGGED", tone: "bad" } : { text: "ok", tone: "good" },
      s.detail,
    ]),
  });

  // ---- duplicate-operation invariants (evaluated after the recovery phase)
  const inv = invariantRows(d);
  if (inv.length > 0) {
    b.push({
      kind: "table",
      title: "Invariants (after recovery)",
      head: ["invariant", "type", "result", "details"],
      rows: inv,
    });
    const ops = d.runs.flatMap((r) =>
      Object.entries(r.operations ?? {}).map(([route, c]): CellLike[] => [
        d.runs.length > 1 ? `${route} (run ${r.index + 1})` : route,
        String(c.ops),
        String(c.confirmed),
        c.ambiguous > 0 ? { text: String(c.ambiguous), tone: "warn" } : "0",
        String(c.rejected),
        `${c.retried} (${c.retriedDuringFault} during fault)`,
      ]),
    );
    if (ops.length > 0) {
      b.push({
        kind: "table",
        title: "Logical operations (one key per operation, reused on retries)",
        head: ["route", "operations", "confirmed 2xx", "ambiguous", "rejected 4xx", "retried"],
        align: ["l", "r", "r", "r", "r", "r"],
        rows: ops,
      });
    }
  }

  // ---- repetitions
  if (d.reproduced.length > 0) {
    const cls = new Map(findings.map((f) => [f.ruleId ?? "", f.classification]));
    b.push({
      kind: "table",
      title: "Rule hits across repetitions",
      head: ["rule", "hits", "classification"],
      align: ["l", "r", "l"],
      rows: d.reproduced.map((x) => {
        const c = cls.get(x.ruleId) ?? (x.runs >= 2 && x.hits === x.runs ? "reproduced-defect" : "observation");
        return [x.ruleId, `${x.hits}/${x.runs}`, c === "reproduced-defect" ? { text: c, tone: "bad" } : c];
      }),
    });
    if (d.repeat < 2) {
      b.push({ kind: "text", tone: "muted", text: "Single repetition: detector hits are observations. Use repeat ≥ 2 to classify reproduced defects." });
    }
  }
  return b;
}

