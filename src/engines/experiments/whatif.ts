/**
 * What-If engine orchestration. docs/03-engines/experiments.md Part A.
 *
 * Arms: baseline + variants (variants inherit every baseline field they do not set; env is merged).
 *  - "process" arm: `start` command, run in `cwd` with a free port in env `PORT` (portEnv), healthy when
 *    `readyWhen` passes; stopped with a process-tree kill. Arms with an identical start spec share a
 *    process key ("same process, different endpoint": e.g. two paths on one app via `workload` overrides).
 *  - "external" arm: an already-running `target` URL.
 *  - "endpoint" arm: neither — the workload's own `target` is used (arms differ only by workload).
 * Design: interleaved / randomised-block / sequential schedule (schedule.ts), reset hook before every
 * run, per-run (default) or per-arm process lifecycle, same seeded data feed for all arms.
 * Analysis: analysis.ts (Holm across metrics × variants). Projections only as `kind: "estimate"`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { EngineError } from "../../core/errors.js";
import type { EngineResult, Finding, Limitation } from "../../core/evidence/schemas.js";
import { createEvidenceStore, createFinding } from "../../core/evidence/store.js";
import { createRng } from "../../core/rng.js";
import type { EngineContext } from "../../core/types.js";
import { median } from "../../shared/stats/quantile.js";
import { fingerprint } from "../../shared/util/fingerprint.js";
import { sha256 } from "../../shared/util/hash.js";
import { runPerformance } from "../performance/index.js";
import type { PerformanceData } from "../performance/types.js";
import {
  type ComparisonInput,
  compareArms,
  extractMetric,
  flagOutliers,
  hypothesisStatus,
  type MetricDef,
  parseMetric,
  requiredRepetitions,
} from "./analysis.js";
import { type RunningApp, type StartAppOptions, startApp } from "./app.js";
import { type CommandSpec, describeFailure, formatArgv, runCommand, toArgv } from "./command.js";
import { type Projection, projectMm1, projectUsl } from "./projection.js";
import { buildSchedule } from "./schedule.js";
import type { ExperimentInput, ReadyWhenInput, SuccessCriterion } from "./schema.js";
import type { ArmFingerprint, ArmSummary, ExperimentData, RunRecord, VariantVerdict } from "./types.js";

export const WHATIF_ENGINE_VERSION = "0.1.0";

export type WorkloadRunner = (
  input: Record<string, unknown>,
  ctx: Partial<EngineContext>,
) => Promise<EngineResult<PerformanceData>>;

export interface WhatIfDeps {
  /** Replace the workload executor (tests). Default: runPerformance. */
  runWorkload?: WorkloadRunner;
  /** Sandbox launch wrapper per arm (Evolution uses it for Docker). */
  wrap?: (arm: string) => StartAppOptions["wrap"] | undefined;
  /** Sandbox description folded into the arm fingerprint (identical limits for all arms). */
  sandboxLabel?: string;
  /** Replace the app starter (tests). */
  startApp?: typeof startApp;
  /** Engine id used for findings/limitations (default "whatif"). */
  engineId?: "whatif" | "evolution";
}

interface ResolvedArm {
  name: string;
  kind: ArmSummary["kind"];
  description?: string | undefined;
  target?: string | undefined;
  start?: string[] | undefined;
  setup?: CommandSpec | undefined;
  teardown?: CommandSpec | undefined;
  reset?: CommandSpec | undefined;
  cwd: string;
  env: Record<string, string>;
  portEnv: string;
  readyWhen: ReadyWhenInput;
  workload: Record<string, unknown>;
  processKey?: string | undefined;
}

const DEFAULT_READY: ReadyWhenInput = { path: "/", timeout: 30_000, interval: 200 };

export function resolveArms(input: ExperimentInput): ResolvedArm[] {
  const base = input.baseline;
  const cwd0 = input.cwd ?? process.cwd();
  const defs =
    input.mode === "aa"
      ? [base, { ...base, name: `${base.name}#2`, description: "A/A copy of the baseline" }]
      : [base, ...input.variants];
  return defs.map((d, i) => {
    const v = i === 0 || input.mode === "aa" ? d : { ...base, ...stripUndefined(d) };
    const env =
      i === 0 || input.mode === "aa" ? { ...(d.env ?? {}) } : { ...(base.env ?? {}), ...(d.env ?? {}) };
    const cwd = path.resolve(cwd0, v.cwd ?? ".");
    const start = v.start !== undefined ? toArgv(v.start) : undefined;
    // A variant that sets its own `target` drops an inherited `start` (and vice versa).
    const own = d as { target?: string; start?: unknown };
    const target = own.start !== undefined && i > 0 ? undefined : v.target;
    const useStart = own.target !== undefined && i > 0 ? undefined : start;
    const kind: ResolvedArm["kind"] = useStart ? "process" : target ? "external" : "endpoint";
    const portEnv = v.portEnv ?? "PORT";
    const processKey = useStart
      ? fingerprint([JSON.stringify(useStart), cwd, JSON.stringify(sortObj(env)), portEnv])
      : undefined;
    return {
      name: d.name,
      kind,
      description: d.description,
      target,
      start: useStart,
      setup: v.setup,
      teardown: v.teardown,
      reset: v.reset ?? input.design.reset,
      cwd,
      env,
      portEnv,
      readyWhen: v.readyWhen ?? DEFAULT_READY,
      workload: {
        ...input.workload,
        ...((i === 0 || input.mode === "aa" ? undefined : base.workload) ?? {}),
        ...(d.workload ?? {}),
      },
      processKey,
    };
  });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function sortObj(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function datasetHash(workload: Record<string, unknown>, cwd: string): Promise<string> {
  const data = workload.data as { rows?: unknown; file?: string } | undefined;
  if (!data) return "none";
  if (data.file) {
    try {
      return sha256(await readFile(path.resolve(cwd, data.file))).slice(0, 16);
    } catch {
      return `file:${data.file}`;
    }
  }
  return sha256(JSON.stringify(data.rows ?? null)).slice(0, 16);
}

function armFingerprint(
  d: PerformanceData | undefined,
  dataset: string,
  sandbox: string | undefined,
): ArmFingerprint | null {
  if (!d) return null;
  const e = d.environment;
  const fp = {
    host: e.hostname,
    os: e.os,
    cpu: e.cpuModel,
    cpus: e.cpus,
    node: e.node,
    dataset,
    ...(sandbox ? { sandbox } : {}),
  };
  return { hash: fingerprint([fp.host, fp.os, fp.cpu, fp.cpus, fp.node, dataset, sandbox]), ...fp };
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

export async function executeExperiment(
  input: ExperimentInput,
  ctx: EngineContext,
  deps: WhatIfDeps = {},
): Promise<EngineResult<ExperimentData>> {
  const engine = deps.engineId ?? "whatif";
  const runId = ctx.newId();
  const startedAt = ctx.clock.isoNow();
  const log = ctx.log.child({ engine, experiment: input.name });
  const limitations: Limitation[] = [];
  const warnings: string[] = [];
  const runWorkload: WorkloadRunner = deps.runWorkload ?? ((i, c) => runPerformance(i as never, c));
  const start = deps.startApp ?? startApp;
  const arms = resolveArms(input);
  const design = input.design;
  const commandTimeout = input.commandTimeout;

  // Metrics
  const metrics: MetricDef[] = [];
  for (const m of input.metrics) {
    const def = parseMetric(m);
    if (def) metrics.push(def);
    else {
      limitations.push({
        code: "WHATIF-METRIC-UNAVAILABLE",
        message: `Metric "${m}" is not measured by the Performance Lab (client-side only); it was skipped`,
        impact: "informational",
      });
    }
  }
  if (design.repetitions < 5) {
    warnings.push(`only ${design.repetitions} repetition(s) per arm: r ≥ 5 is recommended (docs §A.3)`);
    limitations.push({
      code: "WHATIF-FEW-REPETITIONS",
      message: `${design.repetitions} repetition(s) per arm (< 5): verdicts are likely inconclusive`,
      impact: "reduces-confidence",
    });
  }
  if (design.order === "sequential") {
    warnings.push("sequential order (AAAA BBBB) does not cancel drift; prefer interleaved");
    limitations.push({
      code: "WHATIF-SEQUENTIAL-ORDER",
      message: "Runs were not interleaved; drift may bias the comparison",
      impact: "reduces-confidence",
    });
  }
  for (const a of arms) {
    if (a.kind === "endpoint" && typeof a.workload.target !== "string") {
      throw new EngineError(
        "SW_ENGINE_WHATIF_NO_TARGET",
        `Arm "${a.name}" has no start command, no target and the workload has no target`,
      );
    }
  }
  const shared = new Map<string, string[]>();
  for (const a of arms)
    if (a.processKey) shared.set(a.processKey, [...(shared.get(a.processKey) ?? []), a.name]);

  const seedRng = createRng(design.seed);
  const schedule = buildSchedule(
    arms.map((a) => a.name),
    design.repetitions,
    design.order,
    (() => {
      const r = seedRng.fork("schedule");
      return () => r.next();
    })(),
  );

  const armByName = new Map(arms.map((a) => [a.name, a]));
  const runs: RunRecord[] = [];
  const perfData = new Map<number, PerformanceData>();
  const runCmd = async (
    cmd: CommandSpec,
    a: ResolvedArm,
    label: string,
    extraEnv: Record<string, string> = {},
  ) => {
    const argv = toArgv(cmd);
    ctx.safety.audit({ action: `${engine}.command`, detail: { label, arm: a.name, argv: formatArgv(argv) } });
    const r = await runCommand(argv, {
      cwd: a.cwd,
      env: { ...a.env, SW_ARM: a.name, ...extraEnv },
      timeoutMs: commandTimeout,
      signal: ctx.signal,
      clock: ctx.clock,
    });
    if (!r.ok)
      throw new EngineError(
        "SW_ENGINE_WHATIF_COMMAND",
        `${label} failed for arm "${a.name}": ${describeFailure(r)}`,
      );
  };

  const processes = new Map<string, RunningApp>();
  const setupDone = new Set<string>();
  const teardowns: { cmd: CommandSpec; arm: ResolvedArm }[] = [];
  let cancelled = false;
  const isCancelled = () => ctx.signal.aborted || ctx.safety.killSwitch.aborted;

  const launch = async (a: ResolvedArm): Promise<RunningApp> =>
    start({
      command: a.start as string[],
      cwd: a.cwd,
      env: a.env,
      portEnv: a.portEnv,
      readyWhen: {
        path: a.readyWhen.path,
        status: a.readyWhen.status,
        bodyContains: a.readyWhen.bodyContains,
        timeoutMs: a.readyWhen.timeout,
        intervalMs: a.readyWhen.interval,
      },
      signal: ctx.signal,
      clock: ctx.clock,
      wrap: deps.wrap?.(a.name),
    });

  try {
    for (const slot of schedule) {
      if (isCancelled()) {
        cancelled = true;
        break;
      }
      const a = armByName.get(slot.arm) as ResolvedArm;
      const rec: RunRecord = {
        index: slot.index,
        arm: a.name,
        rep: slot.rep,
        block: slot.block,
        status: "ok",
        durationMs: 0,
        metrics: {},
        outlierMetrics: [],
      };
      ctx.events.emit(`${engine}.run.start`, {
        runId,
        index: slot.index,
        arm: a.name,
        rep: slot.rep,
        total: schedule.length,
      });
      const t0 = ctx.clock.now();
      let app: RunningApp | undefined;
      let ownApp = false;
      try {
        if (a.setup !== undefined) {
          const key = fingerprint([JSON.stringify(a.setup), a.cwd, JSON.stringify(sortObj(a.env))]);
          if (!setupDone.has(key)) {
            setupDone.add(key);
            await runCmd(a.setup, a, "setup");
            if (a.teardown !== undefined) teardowns.push({ cmd: a.teardown, arm: a });
          }
        }
        let target: string;
        if (a.kind === "process") {
          const key = a.processKey as string;
          if (design.lifecycle === "per-arm") {
            app = processes.get(key);
            if (!app || app.exited) {
              const ts = ctx.clock.now();
              app = await launch(a);
              rec.startupMs = ctx.clock.now() - ts;
              processes.set(key, app);
            }
          } else {
            const ts = ctx.clock.now();
            app = await launch(a);
            rec.startupMs = ctx.clock.now() - ts;
            ownApp = true;
          }
          target = app.url;
        } else if (a.kind === "external") target = a.target as string;
        else target = a.workload.target as string;
        if (a.reset !== undefined)
          await runCmd(a.reset, a, "reset", {
            SW_TARGET_URL: target,
            ...(app ? { [a.portEnv]: String(app.port) } : {}),
          });
        rec.target = target;
        const wl: Record<string, unknown> = {
          ...a.workload,
          target,
          seed: (a.workload.seed as number | undefined) ?? design.seed,
        };
        const res = await runWorkload(wl, {
          signal: ctx.signal,
          clock: ctx.clock,
          rng: ctx.rng.fork(`run-${slot.index}`),
          log: log.child({ arm: a.name, rep: slot.rep }),
          events: ctx.events,
          evidence: createEvidenceStore(),
          safety: ctx.safety,
          env: ctx.env,
          config: ctx.config,
          newId: ctx.newId,
        });
        rec.perfRunId = res.runId;
        if (res.status === "cancelled") {
          rec.status = "cancelled";
          cancelled = true;
        } else if (res.status === "error" || !res.data) {
          rec.status = "error";
          rec.error = res.limitations.map((l) => l.message).join("; ") || "workload error";
        } else {
          perfData.set(slot.index, res.data);
          rec.generatorSaturated = res.data.generator.saturated;
          for (const m of metrics) {
            const v = extractMetric(res.data, m);
            if (v !== undefined && Number.isFinite(v)) rec.metrics[m.name] = v;
          }
        }
      } catch (e) {
        if (isCancelled()) {
          rec.status = "cancelled";
          cancelled = true;
        } else {
          rec.status = "error";
          rec.error = e instanceof Error ? e.message : String(e);
          log.warn("run failed", { arm: a.name, rep: slot.rep, error: rec.error });
        }
      } finally {
        if (ownApp && app) await app.stop();
      }
      rec.durationMs = ctx.clock.now() - t0;
      runs.push(rec);
      ctx.events.emit(`${engine}.run.end`, {
        runId,
        index: slot.index,
        arm: a.name,
        rep: slot.rep,
        status: rec.status,
        metrics: rec.metrics,
      });
      if (cancelled) break;
      if (design.cooldown > 0) await ctx.clock.sleep(design.cooldown, ctx.signal).catch(() => undefined);
    }
  } finally {
    await Promise.all([...processes.values()].map((p) => p.stop()));
    for (const t of teardowns.reverse()) {
      try {
        await runCmd(t.cmd, t.arm, "teardown");
      } catch (e) {
        warnings.push((e as Error).message);
      }
    }
  }

  // ---- analysis
  const okRuns = (arm: string) => runs.filter((r) => r.arm === arm && r.status === "ok");
  const valuesOf = (arm: string, m: string) =>
    okRuns(arm).flatMap((r) => (r.metrics[m] !== undefined ? [r.metrics[m] as number] : []));
  for (const a of arms) {
    for (const m of metrics) {
      const rs = okRuns(a.name).filter((r) => r.metrics[m.name] !== undefined);
      for (const idx of flagOutliers(rs.map((r) => r.metrics[m.name] as number)))
        rs[idx]?.outlierMetrics.push(m.name);
    }
  }
  const failed = runs.filter((r) => r.status === "error");
  if (failed.length > 0) {
    limitations.push({
      code: "WHATIF-RUN-FAILED",
      message: `${failed.length} run(s) failed and were excluded: ${failed
        .slice(0, 3)
        .map((r) => `${r.arm}#${r.rep}: ${r.error ?? "error"}`)
        .join("; ")}`,
      impact: "reduces-confidence",
    });
  }
  if (runs.some((r) => r.generatorSaturated)) {
    limitations.push({
      code: "WHATIF-GENERATOR-SATURATED",
      message: "The load generator was saturated in at least one run; latency may include generator delay",
      impact: "reduces-confidence",
    });
  }

  const baseline = arms[0] as ResolvedArm;
  const success = input.success as Record<string, SuccessCriterion>;
  const cmpInputs: ComparisonInput[] = [];
  for (const v of arms.slice(1)) {
    for (const m of metrics) {
      cmpInputs.push({
        variant: v.name,
        metric: m,
        baseline: valuesOf(baseline.name, m.name),
        values: valuesOf(v.name, m.name),
        success: success[m.name],
      });
    }
  }
  const compRng = createRng(design.seed).fork("bootstrap");
  const comparisons = compareArms(cmpInputs, {
    alpha: input.alpha,
    B: input.bootstrap,
    equivalenceMargin: input.equivalenceMargin,
    rand: (key) => {
      const r = compRng.fork(key);
      return () => r.next();
    },
  });

  const verdicts: VariantVerdict[] = arms.slice(1).map((v) => {
    const cs = comparisons.filter((c) => c.variant === v.name);
    return {
      variant: v.name,
      hypothesis: hypothesisStatus(cs),
      improved: cs.filter((c) => c.verdict === "improved").map((c) => c.metric),
      regressed: cs.filter((c) => c.verdict === "regressed").map((c) => c.metric),
      inconclusive: cs.filter((c) => c.verdict === "inconclusive").map((c) => c.metric),
    };
  });

  // Fingerprints
  const armSummaries: ArmSummary[] = [];
  const fpWarnings: string[] = [];
  for (const a of arms) {
    const rs = runs.filter((r) => r.arm === a.name);
    const dataset = await datasetHash(a.workload, a.cwd);
    const prints = rs.flatMap((r) => {
      const d = perfData.get(r.index);
      return d ? [armFingerprint(d, dataset, deps.sandboxLabel)] : [];
    });
    const fp = prints[0] ?? null;
    if (new Set(prints.map((p) => p?.hash)).size > 1)
      fpWarnings.push(`arm "${a.name}": environment fingerprint changed between runs`);
    const medians: Record<string, number> = {};
    for (const m of metrics) {
      const vals = valuesOf(a.name, m.name);
      if (vals.length > 0) medians[m.name] = median(vals);
    }
    armSummaries.push({
      name: a.name,
      kind: a.kind,
      sharesProcessWith: a.processKey ? (shared.get(a.processKey) ?? []).filter((n) => n !== a.name) : [],
      command: a.start ? formatArgv(a.start) : undefined,
      target:
        a.kind === "external" ? a.target : a.kind === "endpoint" ? (a.workload.target as string) : undefined,
      description: a.description,
      fingerprint: fp,
      runs: rs.length,
      failedRuns: rs.filter((r) => r.status === "error").length,
      medians,
    });
  }
  const baseFp = armSummaries[0]?.fingerprint;
  for (const s of armSummaries.slice(1)) {
    if (baseFp && s.fingerprint && s.fingerprint.hash !== baseFp.hash) {
      const diffs = (["host", "os", "cpu", "cpus", "node", "dataset", "sandbox"] as const).filter(
        (k) => baseFp[k] !== s.fingerprint?.[k],
      );
      fpWarnings.push(`arm "${s.name}" environment differs from baseline (${diffs.join(", ")})`);
    }
  }
  if (fpWarnings.length > 0) {
    limitations.push({
      code: "WHATIF-FINGERPRINT-MISMATCH",
      message: fpWarnings.join("; "),
      impact: "reduces-confidence",
    });
    warnings.push(...fpWarnings);
  }

  // Noise floor (A/A)
  let noiseFloor: ExperimentData["noiseFloor"];
  if (input.mode === "aa") {
    noiseFloor = comparisons.map((c) => ({
      metric: c.metric,
      mde: c.mde,
      relativeSd: c.relativeSd,
      recommendedFor5pct: requiredRepetitions(c.relativeSd, 0.05, input.alpha),
    }));
  }

  // Projections (estimates only)
  const projections: Projection[] = [];
  if (input.projection) {
    for (const a of arms) {
      const ds = okRuns(a.name).flatMap((r) => {
        const d = perfData.get(r.index);
        return d ? [d] : [];
      });
      if (ds.length === 0 || input.projection.rates.length === 0) continue;
      projections.push(
        ...projectMm1(
          a.name,
          median(ds.map((d) => d.totals.rps)),
          median(ds.map((d) => d.latency.corrected.mean)),
          input.projection.rates,
        ),
      );
    }
    projections.push(...projectUsl(input.projection.points, input.projection.concurrency));
  }

  const inconclusive = comparisons.filter((c) => c.verdict === "inconclusive");
  if (inconclusive.length > 0) {
    const rec = Math.max(...inconclusive.map((c) => c.recommendedRepetitions ?? 0));
    limitations.push({
      code: "WHATIF-INCONCLUSIVE",
      message: `${inconclusive.length} comparison(s) inconclusive; ≈ ${rec} repetitions per arm recommended`,
      impact: "informational",
    });
  }
  const aaDifference =
    input.mode === "aa" && comparisons.some((c) => c.verdict === "improved" || c.verdict === "regressed");
  if (aaDifference) {
    limitations.push({
      code: "WHATIF-AA-DIFFERENCE",
      message:
        "A/A test found a significant difference between identical arms: the environment is not stable enough for comparisons",
      impact: "invalidates",
    });
  }

  const data: ExperimentData = {
    schema: 1,
    name: input.name,
    hypothesis: input.hypothesis,
    mode: input.mode,
    design: {
      repetitions: design.repetitions,
      order: design.order,
      seed: design.seed,
      lifecycle: design.lifecycle,
      alpha: input.alpha,
      bootstrap: input.bootstrap,
      equivalenceMargin: input.equivalenceMargin,
    },
    schedule,
    arms: armSummaries,
    runs,
    metrics: metrics.map((m) => ({ name: m.name, direction: m.direction, unit: m.unit })),
    comparisons,
    verdicts,
    ...(noiseFloor ? { noiseFloor } : {}),
    fingerprints: { consistent: fpWarnings.length === 0, warnings: fpWarnings },
    projections,
    warnings,
    methods: {
      unit: "per-repetition summary values (one value per run and metric); latency is coordinated-omission corrected, ms",
      estimate:
        "relative change of medians (variant − baseline)/|baseline|; Hodges–Lehmann shift in metric units",
      ci: `bootstrap ${input.bootstrap} resamples (BCa, percentile fallback), seeded (seed ${design.seed}), ${Math.round((1 - input.alpha) * 100)}%`,
      test: "Mann–Whitney U (exact for small n without ties, else normal approximation with tie correction); Cliff's δ effect size",
      multipleTesting: "Holm–Bonferroni across all metrics × variants",
      verdict: `improved/regressed when Holm p < ${input.alpha} and the CI excludes 0; no-significant-change when the CI lies within ±${input.equivalenceMargin} (n ≥ 5); otherwise inconclusive with recommended repetitions (power 0.8)`,
      outliers: "runs with MAD z > 3.5 are flagged, never dropped",
      schedule: `${design.order} order, ${design.lifecycle} app lifecycle, seed ${design.seed}`,
      projections: "projections are estimates (M/M/1 queueing or USL fit), never measurements",
    },
  };

  const findings: Finding[] = [];
  const fctx = { newId: ctx.newId, clock: ctx.clock };
  if (input.mode === "compare") {
    for (const c of comparisons) {
      if (c.verdict !== "improved" && c.verdict !== "regressed") continue;
      findings.push(
        createFinding(
          {
            engine,
            ruleId: c.verdict === "improved" ? "WHATIF-IMPROVED" : "WHATIF-REGRESSED",
            category: "performance",
            title: `${c.variant}: ${c.metric} ${c.verdict} by ${pct(c.relativeChange)} vs ${baseline.name}`,
            description: `Experiment "${input.name}": ${c.metric} median ${c.medians.baseline.toFixed(3)} → ${c.medians.variant.toFixed(3)} (${pct(c.relativeChange)}, ${Math.round(c.ci.level * 100)}% CI ${pct(c.ci.lower)} … ${pct(c.ci.upper)}, Holm p=${c.pAdjusted.toPrecision(3)}, Cliff's δ ${c.cliffsDelta.delta.toFixed(2)} ${c.cliffsDelta.magnitude}, n=${c.n.baseline}/${c.n.variant}).`,
            severity: c.verdict === "improved" ? "info" : "medium",
            classification: "observation",
            confidence: c.outliers.baseline.length + c.outliers.variant.length > 0 ? 0.8 : 0.9,
            evidence: [
              {
                kind: "comparison",
                metric: c.metric,
                change: c.relativeChange,
                ci95: [c.ci.lower, c.ci.upper],
                pValue: c.pAdjusted,
              },
            ],
            affected: [input.name, c.variant],
            tags: [engine, c.verdict],
          },
          fctx,
        ),
      );
    }
  }
  for (const f of findings) ctx.evidence.addFinding(f);

  let status: EngineResult["status"];
  if (cancelled || isCancelled()) status = "cancelled";
  else if (runs.length > 0 && runs.every((r) => r.status !== "ok")) status = "error";
  else if (aaDifference || verdicts.some((v) => v.hypothesis === "rejected")) status = "failed";
  else status = "passed";

  return {
    schemaVersion: 1,
    engine,
    runId,
    status,
    startedAt,
    endedAt: ctx.clock.isoNow(),
    findings,
    limitations,
    artifacts: [],
    data,
  };
}
