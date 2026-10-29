/**
 * Reliability findings. See docs/03-engines/reliability-lab.md §2 (verdict with evidence) and
 * docs/03-engines/evidence-and-history.md (trust ladder).
 *
 * - threshold rules (steady state, hypothesis) → `threshold-breach`
 * - detector hits → `observation`; hit in every one of ≥ 2 repetitions → `reproduced-defect`
 * - one `observation` (info) summary per experiment with the measured behaviour.
 */

import type { Evidence, Finding } from "../../core/evidence/schemas.js";
import { createFinding } from "../../core/evidence/store.js";
import type { EngineContext } from "../../core/types.js";
import type { ReliabilityInput } from "./schema.js";
import type { Detection, ReliabilityData } from "./types.js";

export const ENGINE_VERSION = "0.1.0";

function routeLabels(input: ReliabilityInput, names: Iterable<string>): string[] {
  const out: string[] = [];
  for (const n of names) {
    const r = input.workload.routes.find((x) => x.name === n);
    out.push(r ? `${r.method.toUpperCase()} ${r.path.split("?")[0]}` : n);
  }
  return out;
}

function reproCommand(input: ReliabilityInput): string {
  const parts = [
    "sw reliability run",
    input.scenario,
    `--dependency ${input.dependency}`,
    `--duration ${Math.round(input.duration / 1000)}s`,
  ];
  for (const [k, v] of Object.entries(input.params)) parts.push(`--param ${k}=${String(v)}`);
  for (const s of input.steadyState) parts.push(`--steady "${s}"`);
  parts.push("--approve-disruptive");
  return parts.join(" ");
}

export function buildFindings(
  data: ReliabilityData,
  ctx: Pick<EngineContext, "newId" | "clock">,
  input: ReliabilityInput,
): { findings: Finding[]; reproduced: { ruleId: string; hits: number; runs: number }[] } {
  const findings: Finding[] = [];
  const applied = data.runs.filter((r) => r.fault.applied);
  const groups = new Map<string, { last: Detection; hits: number }>();
  for (const r of data.runs) {
    const seen = new Set<string>();
    for (const d of r.detections) {
      const key =
        d.group ?? (d.ruleId === "reliability/isolation-failure" ? `${d.ruleId}|${d.title}` : d.ruleId);
      if (seen.has(key)) continue;
      seen.add(key);
      const g = groups.get(key);
      groups.set(key, { last: d, hits: (g?.hits ?? 0) + 1 });
    }
  }
  const affectedRoutes = input.workload.routes
    .filter((r) => r.dependsOn?.includes(input.dependency))
    .map((r) => r.name);
  const affected = [
    `dependency:${input.dependency}`,
    ...routeLabels(input, affectedRoutes.length ? affectedRoutes : input.workload.routes.map((r) => r.name)),
  ];
  const reproduced: { ruleId: string; hits: number; runs: number }[] = [];
  const faultNote: Evidence = {
    kind: "note",
    text: `Fault: ${data.faults.join(" + ")} on ${data.dependency} via ${data.injector} for ${data.phases.faultMs} ms (scenario ${data.scenario})`,
  };

  for (const [, { last, hits }] of groups) {
    const runs = last.kind === "threshold" ? data.runs.length : Math.max(1, applied.length);
    reproduced.push({ ruleId: last.ruleId, hits, runs });
    const classification =
      last.kind === "threshold"
        ? "threshold-breach"
        : runs >= 2 && hits === runs
          ? "reproduced-defect"
          : "observation";
    const confidence =
      last.kind === "threshold"
        ? 0.9
        : classification === "reproduced-defect"
          ? 0.95
          : Math.min(0.85, 0.5 + 0.3 * (hits / runs));
    const evidence: Evidence[] = [
      ...last.metrics.map((m) => ({
        kind: "measurement" as const,
        metric: m.metric,
        value: Number.isFinite(m.value) ? m.value : 0,
        unit: m.unit || "value",
      })),
      ...(last.notes ?? []).map((text) => ({ kind: "note" as const, text })),
      faultNote,
      { kind: "note", text: `Detected in ${hits}/${runs} run(s)` },
    ];
    findings.push(
      createFinding(
        {
          engine: "reliability",
          ruleId: last.ruleId,
          category: "reliability",
          title: last.title.slice(0, 200),
          description: last.description,
          severity: last.severity,
          classification,
          confidence,
          evidence,
          affected:
            last.ruleId === "reliability/isolation-failure" ? [`dependency:${input.dependency}`] : affected,
          ...(last.recommendation ? { recommendation: last.recommendation } : {}),
          reproduction: {
            steps: [
              `Point the app's ${data.dependency} dependency at the fault proxy`,
              `Run ${data.scenario} (${data.faults.join(" + ")}) for ${data.phases.faultMs} ms under ${data.workload.rate} req/s`,
            ],
            command: reproCommand(input),
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
            artifacts: [],
          },
          tags: ["reliability", data.scenario],
        },
        ctx,
      ),
    );
  }

  // ---- summary observation (measured behaviour)
  const last = applied[applied.length - 1];
  if (last) {
    const ev: Evidence[] = [
      { kind: "measurement", metric: "fault.error_rate", value: last.during.errorRate, unit: "ratio" },
      { kind: "measurement", metric: "fault.timeout_rate", value: last.during.timeoutRate, unit: "ratio" },
      {
        kind: "measurement",
        metric: "fault.p95",
        value: Number.isFinite(last.during.p95) ? last.during.p95 : 0,
        unit: "ms",
      },
      {
        kind: "measurement",
        metric: "steady.p95",
        value: Number.isFinite(last.steady.p95) ? last.steady.p95 : 0,
        unit: "ms",
      },
    ];
    if (last.recovery?.recoveryMs !== null && last.recovery?.recoveryMs !== undefined) {
      ev.push({ kind: "measurement", metric: "recovery.time", value: last.recovery.recoveryMs, unit: "ms" });
    }
    if (last.amplification)
      ev.push({
        kind: "measurement",
        metric: "retry.amplification",
        value: Math.round(last.amplification.factor * 100) / 100,
        unit: "x",
      });
    if (last.breaker)
      ev.push({ kind: "note", text: `Circuit breaker: ${last.breaker.verdict} (${last.breaker.reason})` });
    if (last.timeout)
      ev.push({ kind: "note", text: `Timeout: ${last.timeout.verdict} (${last.timeout.reason})` });
    for (const inv of last.invariants ?? [])
      ev.push({ kind: "note", text: `Invariant ${inv.status}: ${inv.name}: ${inv.detail}` });
    for (const c of last.checks)
      ev.push({
        kind: "threshold",
        expression: `${c.phase}: ${c.expression}`,
        actual: Number.isFinite(c.actual) ? c.actual : 0,
        passed: c.passed,
      });
    ev.push(faultNote);
    const rec = last.recovery?.recovered
      ? `recovered in ${((last.recovery.recoveryMs ?? 0) / 1000).toFixed(1)} s`
      : "no recovery observed";
    findings.push(
      createFinding(
        {
          engine: "reliability",
          ruleId: "reliability/experiment",
          category: "reliability",
          title:
            `${data.scenario} on ${data.dependency}: hypothesis ${data.verdict}, ${(last.during.errorRate * 100).toFixed(1)}% errors during fault, ${rec}`.slice(
              0,
              200,
            ),
          description: `Steady p95 ${fmt(last.steady.p95)} ms → fault p95 ${fmt(last.during.p95)} ms; error rate ${(last.steady.errorRate * 100).toFixed(1)}% → ${(last.during.errorRate * 100).toFixed(1)}% (${data.runs.length} run(s)).`,
          severity: "info",
          classification: "observation",
          confidence: 0.9,
          evidence: ev,
          affected,
          tags: ["reliability", data.scenario, "summary"],
        },
        ctx,
      ),
    );
  }
  return { findings, reproduced };
}

function fmt(x: number): string {
  return Number.isFinite(x) ? (Math.round(x * 10) / 10).toString() : "n/a";
}
