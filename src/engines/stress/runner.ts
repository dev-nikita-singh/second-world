/**
 * Stress runner: executes planned stages sequentially through the Performance Lab, applies stop
 * conditions, breakpoint bisection, and builds StressData + findings.
 * See docs/03-engines/stress-capacity-lab.md §1–§6.
 */
import {
  createUndiciExecutor,
  type ExecutorSafety,
  type HttpExecutor,
} from "../../adapters/http/undici-executor.js";
import {
  evaluateThreshold,
  parseThresholds,
  type ThresholdEntry,
  type ThresholdSpec,
} from "../../core/config/thresholds.js";
import { parseDuration } from "../../core/config/units.js";
import { SafetyError } from "../../core/errors.js";
import type { EngineResult, Finding, Limitation } from "../../core/evidence/schemas.js";
import { createFinding } from "../../core/evidence/store.js";
import type { EngineContext } from "../../core/types.js";
import { type PerformanceDeps, runPerformance } from "../performance/index.js";
import type { PerformanceData } from "../performance/types.js";
import {
  applySaturationInvalidation,
  buildCurves,
  findKnee,
  firstBreach,
  soakDrift,
  spikeRecovery,
  testedCapacity,
  uslFor,
} from "./analysis.js";
import { defaultMinStep, nextBisectionLevel, type PlannedStage, planStages } from "./planner.js";
import { type StressInput, stagePerfInput } from "./schema.js";
import type { StageResult, StressData, StressStopReason } from "./types.js";

export const STRESS_ENGINE_VERSION = "0.1.0";

export type StageRunner = (
  input: Record<string, unknown>,
  ctx: Partial<EngineContext>,
  deps: PerformanceDeps,
) => Promise<EngineResult<PerformanceData>>;

export interface StressDeps {
  /** Performance deps passed to every stage (executor is overridden when stages share connections). */
  perf?: PerformanceDeps;
  /** Replace the stage executor (tests). Default: runPerformance. */
  runStage?: StageRunner;
}

/** Perf limitation: requests waited for the safety rate cap (closed/iterations models). */
export const THROTTLE_CODE = "PERF-THROTTLED-BY-SAFETY";

const isLittlesLaw = (reason: string): boolean => reason.startsWith("Little's Law");

const WINDOW_STATS = new Set(["p95", "p99", "error_rate"]);

/** Thresholds evaluable on 1 s ticks: scope http, stat p95/p99/error_rate. */
export function windowThresholds(entries: readonly ThresholdEntry[]): ThresholdEntry[] {
  return entries.filter((t) => t.scope === "http" && WINDOW_STATS.has(t.stat));
}

function sharedExecutor(input: StressInput, levels: number[], safety?: ExecutorSafety): HttpExecutor | null {
  if (input.isolateStages) return null;
  const b = input.base;
  const http = (b.http ?? {}) as {
    connections?: number;
    keepAlive?: boolean;
    pipelining?: number;
    version?: string;
  };
  const timeout = b.timeout !== undefined ? parseDuration(b.timeout as string | number) : 10_000;
  const connectTimeout =
    b.connectTimeout !== undefined ? parseDuration(b.connectTimeout as string | number) : 5_000;
  const maxLevel = Math.max(1, ...levels);
  const connections =
    http.connections ??
    (input.loadType === "vus"
      ? Math.round(maxLevel)
      : Math.min(1024, Math.max(64, Math.min(10_000, Math.ceil(((maxLevel * timeout) / 1000) * 1.1)))));
  const real = createUndiciExecutor({
    connections,
    keepAlive: http.keepAlive ?? true,
    pipelining: http.pipelining ?? 1,
    timeoutMs: timeout,
    connectTimeoutMs: connectTimeout,
    allowH2: http.version === "2",
    safety, // F6 (sw-perf): pinned DNS, redirect checks, DNS-rebind re-checks
  });
  return real;
}

/** Wraps an executor so the Performance Lab's per-run close() does not close the shared pool. */
function noCloseView(ex: HttpExecutor): HttpExecutor {
  return {
    execute: (req, signal) => ex.execute(req, signal),
    get inFlight() {
      return ex.inFlight;
    },
    get openSockets() {
      return ex.openSockets;
    },
    close: async () => {},
  };
}

function toStageResult(
  p: PlannedStage,
  res: EngineResult<PerformanceData>,
  startMs: number,
  endMs: number,
  abortedEarly: string | null,
  errorRateStop: number,
): StageResult {
  const d = res.data;
  const thresholds = (d?.thresholds ?? []).map((t) => ({
    expression: t.expression,
    metric: t.metric,
    actual: t.actual,
    threshold: t.threshold,
    passed: t.passed,
  }));
  const errorRate = d?.totals.errorRate ?? 0;
  const throttleLim = res.limitations.find((l) => l.code === THROTTLE_CODE);
  const throttled = d?.totals.throttled ?? 0;
  const capped = throttleLim !== undefined || throttled > 0;
  const capMatch = throttleLim ? /\((\d+(?:\.\d+)?) req\/s/.exec(throttleLim.message) : null;
  const breachReasons: string[] = [];
  if (abortedEarly) breachReasons.push(`consecutive-windows: ${abortedEarly}`);
  for (const t of thresholds) if (!t.passed && t.actual !== null) breachReasons.push(t.expression);
  if (errorRate > errorRateStop)
    breachReasons.push(`error-rate ${(errorRate * 100).toFixed(1)}% > ${(errorRateStop * 100).toFixed(1)}%`);
  let status: StageResult["status"];
  if (res.status === "error") status = "error";
  else if (res.status === "cancelled" && !abortedEarly) status = "cancelled";
  else status = breachReasons.length > 0 ? "breached" : "passed";
  const lat = d?.latency.corrected;
  // Every request failed (5xx, resets, timeouts): closed-loop VUs spin on instant failures, so a
  // generator-saturation verdict would hide that the target failed everything (same rule as the
  // Performance Lab's target-unreachable case).
  const requests = d?.totals.requests ?? 0;
  const allFailed = requests > 0 && (d?.totals.failed ?? 0) >= requests;
  const satReasons = d?.generator.reasons ?? [];
  const genSaturated = (d?.generator.saturated ?? false) && !allFailed;
  return {
    index: p.index,
    kind: p.kind,
    label: p.label,
    level: p.level,
    holdMs: p.holdMs,
    settleMs: p.settleMs,
    status,
    ...(res.limitations.some((l) => l.code === "target-unreachable") ? { targetUnreachable: true } : {}),
    breachReasons,
    perfRunId: res.runId,
    perfStatus: res.status,
    startedAt: res.startedAt,
    endedAt: res.endedAt,
    startMs,
    endMs,
    measuredMs: d?.window.measuredMs ?? 0,
    requests,
    ok: d?.totals.ok ?? 0,
    failed: d?.totals.failed ?? 0,
    errorRate,
    throughput: d?.totals.rps ?? 0,
    ...(d?.totals.targetRate !== undefined ? { targetRate: d.totals.targetRate } : {}),
    ...(d?.totals.achievedRate !== undefined ? { achievedRate: d.totals.achievedRate } : {}),
    meanInFlight: d?.generator.meanInFlight ?? 0,
    latency: {
      mean: lat?.mean ?? 0,
      p50: lat?.p50 ?? 0,
      p90: lat?.p90 ?? 0,
      p95: lat?.p95 ?? 0,
      p99: lat?.p99 ?? 0,
      max: lat?.max ?? 0,
    },
    thresholds,
    generator: {
      // A Little's-Law-only verdict is a consistency check, not proof of saturation (it aliases with
      // constant arrivals on short stages); it reduces confidence instead of invalidating.
      saturated: genSaturated && satReasons.some((r) => !isLittlesLaw(r)),
      littlesLawOnly: genSaturated && satReasons.every((r) => isLittlesLaw(r)),
      reasons: d?.generator.reasons ?? [],
      cpuPercent: d?.generator.cpuPercent ?? 0,
      eventLoopDelayP99Ms: d?.generator.eventLoopDelayP99Ms ?? 0,
    },
    invalid: false,
    capped,
    throttled,
    ...(capMatch?.[1] !== undefined ? { capRps: Number(capMatch[1]) } : {}),
    abortedEarly: abortedEarly !== null,
    series: (d?.series ?? []).map((s) => ({
      t: s.t,
      requests: s.requests,
      failed: s.failed,
      rps: s.rps,
      p95: s.p95,
      p99: s.p99,
    })),
    ...(d ? { histogram: d.histograms.global.corrected } : {}),
  };
}

export async function executeStress(
  input: StressInput,
  ctx: EngineContext,
  deps: StressDeps = {},
): Promise<EngineResult<StressData>> {
  const runId = ctx.newId();
  const startedAt = ctx.clock.isoNow();
  const t0 = ctx.clock.now();
  const lt = input.loadType;
  const plan = planStages(input, input.limits.maxStages);
  const limitations: Limitation[] = [];
  const thresholdEntries = parseThresholds(
    input.base.thresholds as Record<string, ThresholdSpec> | undefined,
  );
  const winThresholds = windowThresholds(thresholdEntries);
  const k = input.stopWhen.consecutiveWindows;
  const runStage: StageRunner = deps.runStage ?? ((i, c, d) => runPerformance(i as never, c, d));
  const baseWarmup =
    input.base.warmup !== undefined ? parseDuration(input.base.warmup as string | number) : 0;
  const shared = sharedExecutor(
    input,
    [...plan.map((p) => p.level), ...(input.breakpoint ? [input.breakpoint.to] : [])],
    ctx.safety as ExecutorSafety,
  );
  const stages: StageResult[] = [];
  /** Limitations of each stage's Performance Lab run, parallel to `stages`. */
  const stageLims: Limitation[][] = [];
  let stopReason: StressStopReason = "completed";
  let stopDetail: string | undefined;
  let totalRequests = 0;
  let environment: PerformanceData["environment"] | undefined;
  const target = String(input.base.target ?? "");
  const breachStops = input.mode !== "spike" && input.mode !== "soak" && input.stopWhen.onBreach;
  const windowAbortEnabled = k > 0 && winThresholds.length > 0 && input.mode !== "spike";

  const runOne = async (p: PlannedStage): Promise<StageResult | null> => {
    if (ctx.signal.aborted || ctx.safety.killSwitch.aborted) {
      stopReason = "cancelled";
      return null;
    }
    if (stages.length >= input.limits.maxStages) {
      stopReason = "max-stages";
      return null;
    }
    const elapsed = ctx.clock.now() - t0;
    const lim = input.limits;
    if (lim.maxDuration !== undefined && elapsed + p.holdMs + p.settleMs > lim.maxDuration) {
      stopReason = "budget";
      stopDetail = `next stage (${p.label}) would exceed limits.maxDuration`;
      return null;
    }
    if (lim.maxRequests !== undefined && totalRequests >= lim.maxRequests) {
      stopReason = "budget";
      stopDetail = "limits.maxRequests reached";
      return null;
    }
    const perfInput = stagePerfInput(
      input.base,
      lt,
      p.level,
      p.holdMs,
      p.settleMs,
      stages.length === 0 ? baseWarmup : 0,
      p.index,
    );
    const stageCtl = new AbortController();
    let abortedEarly: string | null = null;
    let consecutive = 0;
    let lastReq = 0;
    let lastErr = 0;
    const off = windowAbortEnabled
      ? ctx.events.on("perf.tick", (payload) => {
          const t = payload as {
            phase: string;
            p95: number;
            p99: number;
            requests: number;
            totalErrors: number;
          };
          const dReq = t.requests - lastReq;
          const dErr = t.totalErrors - lastErr;
          lastReq = t.requests;
          lastErr = t.totalErrors;
          if (t.phase !== "measure" || dReq <= 0) return;
          const failed = winThresholds.filter((w) => {
            const actual = w.stat === "p95" ? t.p95 : w.stat === "p99" ? t.p99 : dErr / dReq;
            return !evaluateThreshold(w, actual);
          });
          if (failed.length > 0) consecutive++;
          else consecutive = 0;
          if (consecutive >= k && !stageCtl.signal.aborted) {
            abortedEarly = `${failed.map((f) => f.source).join(", ")} failed ${k} consecutive 1 s windows`;
            stageCtl.abort();
          }
        })
      : () => {};
    ctx.events.emit("stress.stage.start", { runId, stage: p.index, label: p.label, level: p.level });
    const startMs = ctx.clock.now();
    let res: EngineResult<PerformanceData>;
    try {
      res = await runStage(
        perfInput,
        { ...ctx, signal: AbortSignal.any([ctx.signal, stageCtl.signal]) },
        { ...(deps.perf ?? {}), ...(shared ? { executor: noCloseView(shared) } : {}) },
      );
    } catch (e) {
      off();
      if (e instanceof SafetyError && stages.length > 0) {
        stopReason = "safety";
        stopDetail = e.message;
        limitations.push({
          code: "STRESS-SAFETY-STOP",
          message: `Stopped before ${p.label}: ${e.message}`,
          impact: "informational",
        });
        return null;
      }
      throw e;
    }
    off();
    const endMs = ctx.clock.now();
    const sr = toStageResult(p, res, startMs, endMs, abortedEarly, input.stopWhen.errorRate);
    if (res.data?.environment && !environment) environment = res.data.environment;
    totalRequests += sr.requests;
    stages.push(sr);
    stageLims.push(res.limitations);
    ctx.events.emit("stress.stage.end", {
      runId,
      stage: p.index,
      label: p.label,
      level: p.level,
      status: sr.status,
      p95: sr.latency.p95,
      throughput: sr.throughput,
      errorRate: sr.errorRate,
    });
    if (sr.status === "cancelled") stopReason = "cancelled";
    else if (sr.status === "error") {
      stopReason = "error";
      stopDetail = `stage ${p.label}: performance run ended with status error`;
    } else if (sr.generator.saturated && input.stopWhen.onSaturation) {
      stopReason = "saturation";
      stopDetail = sr.generator.reasons.join("; ");
    } else if (sr.capped && input.mode === "breakpoint") {
      // More load cannot reach the target: every higher stage would sit at the same cap.
      stopReason = "safety-cap";
      stopDetail = `stage ${p.label} was throttled by the safety rate cap${sr.capRps !== undefined ? ` (${sr.capRps} req/s)` : ""}`;
    }
    return sr;
  };

  const halted = (): boolean => stopReason !== "completed";
  let bisection: StressData["breakpoint"] | undefined;

  try {
    if (input.mode === "breakpoint" && input.breakpoint) {
      const bp = input.breakpoint;
      const minStep = bp.minStep ?? defaultMinStep(bp.step, lt);
      let lastPass: number | null = null;
      let firstFail: number | null = null;
      for (const p of plan) {
        const r = await runOne(p);
        if (!r || halted()) break;
        if (r.status === "breached") {
          firstFail = r.level;
          break;
        }
        lastPass = r.level;
      }
      let bisections = 0;
      let converged = false;
      if (firstFail !== null && lastPass !== null && !halted()) {
        let idx = plan.length;
        for (let guard = 0; guard < 64; guard++) {
          const next = nextBisectionLevel(lastPass, firstFail, minStep, lt);
          if (next === null) {
            converged = true;
            break;
          }
          const r: StageResult | null = await runOne({
            index: idx++,
            kind: "bisect",
            label: `bisect ${next} ${lt === "vus" ? "VUs" : "rps"}`,
            level: next,
            holdMs: input.hold,
            settleMs: input.settle,
          });
          if (!r) break;
          bisections++;
          if (r.status === "breached") firstFail = r.level;
          else if (r.status === "passed") lastPass = r.level;
          if (halted()) break;
        }
      }
      if (stopReason === "completed" && firstFail !== null) {
        stopReason = "breach";
        stopDetail = `first failing load ${firstFail}`;
      }
      bisection = { lastPass, firstFail, minStep, bisectionStages: bisections, converged };
    } else {
      let sinceBreach = -1;
      for (const p of plan) {
        const r = await runOne(p);
        if (!r || halted()) break;
        if (sinceBreach >= 0) sinceBreach++;
        else if (breachStops && r.status === "breached") sinceBreach = 0;
        if (sinceBreach >= input.stopWhen.continueAfterBreach) {
          stopReason = "breach";
          stopDetail = `stopped after the first breach (${input.stopWhen.continueAfterBreach} extra stage(s))`;
          break;
        }
        if (r.errorRate > input.stopWhen.errorRate && r.kind !== "spike-peak") {
          stopReason = "error-rate";
          stopDetail = `error rate ${(r.errorRate * 100).toFixed(1)}% at ${r.label}`;
          break;
        }
      }
    }
  } finally {
    if (shared) await shared.close();
  }

  // ---- analysis
  // A target that refuses every connection is not a saturated generator: say what happened.
  const unreachable =
    stages.length > 0 && stages.every((s) => s.status === "error" && s.targetUnreachable === true);
  const allErrored = stages.length > 0 && stages.every((s) => s.status === "error");
  if (allErrored) limitations.push(...allErroredLimitations(stageLims, target, unreachable));
  const invalidFrom = unreachable ? null : applySaturationInvalidation(stages);
  if (invalidFrom !== null) {
    const s = stages[invalidFrom] as StageResult;
    limitations.push({
      code: "STRESS-GENERATOR-SATURATED",
      message: `Load generator saturated at stage ${s.label} (${s.generator.reasons.join("; ")}); conclusions from this stage onward are invalid.`,
      impact: "invalidates",
    });
  }
  const llStages = stages.filter((s) => s.generator.littlesLawOnly);
  if (llStages.length > 0) {
    limitations.push({
      code: "STRESS-GENERATOR-LITTLES-LAW",
      message: `Generator self-check reported only a Little's Law mismatch at ${llStages.map((s) => s.label).join(", ")}; treated as reduced confidence, not saturation.`,
      impact: "reduces-confidence",
    });
  }
  if (thresholdEntries.length === 0 && input.mode !== "soak" && input.mode !== "spike") {
    limitations.push({
      code: "STRESS-NO-THRESHOLDS",
      message: `No thresholds given: compliance only reflects the error-rate stop condition (${input.stopWhen.errorRate * 100}%).`,
      impact: "reduces-confidence",
    });
  }
  // ---- safety rate cap (docs/03-engines/stress-capacity-lab.md §6: never describe the cap as capacity)
  const capped = stages.filter((s) => s.capped);
  const capRps = capped.find((s) => s.capRps !== undefined)?.capRps ?? null;
  const budgetRps = (input.base.budget as { maxRps?: number } | undefined)?.maxRps;
  const capLabel =
    capRps === null
      ? "the safety rate cap"
      : `${budgetRps !== undefined && budgetRps <= capRps ? "budget.maxRps" : "safety.maxRps"} ${capRps} req/s`;
  const curveMode = input.mode === "step" || input.mode === "ramp" || input.mode === "breakpoint";
  const capacity =
    input.mode === "spike" || input.mode === "soak"
      ? { testedCapacity: null, stageIndex: null, statement: `Not applicable to ${input.mode} mode.` }
      : testedCapacity(stages, lt, capLabel);
  const fb = firstBreach(stages.filter((s) => s.kind !== "spike-peak"));
  const kneeAll = curveMode ? findKnee(stages) : null;
  const uncapped = stages.filter((s) => !s.capped);
  const knee = curveMode ? (capped.length > 0 ? findKnee(uncapped) : kneeAll) : null;
  const notes: string[] = [];
  let safetyCap: StressData["safetyCap"];
  if (capped.length > 0) {
    const capStageCapped =
      capacity.stageIndex !== null && capped.some((s) => s.index === capacity.stageIndex);
    const fromKneeCapped = kneeAll !== null && capped.some((s) => s.level >= kneeAll.level);
    const impact = capStageCapped || fromKneeCapped ? "invalidates" : "reduces-confidence";
    safetyCap = { rps: capRps, cappedStages: capped.map((s) => s.index), impact };
    limitations.push({
      code: "STRESS-SAFETY-RATE-CAP",
      message: `${capped.length} stage(s) (${capped.map((s) => s.label).join(", ")}) were throttled by ${capLabel}: their throughput reflects the cap, not the target's capacity${
        impact === "invalidates"
          ? "; the capacity statement does not describe the target"
          : "; conclusions from uncapped stages stand"
      }. Raise the cap (if allowed for this environment) to test higher load.`,
      impact,
    });
    if (curveMode) {
      notes.push(
        `Knee${input.usl ? " and USL fit" : ""} computed from the ${uncapped.length} uncapped stage(s) only; ${capped.length} stage(s) throttled by ${capLabel} were excluded.`,
      );
    }
  }
  const data: StressData = {
    schema: 1,
    mode: input.mode,
    loadType: lt,
    target,
    stopReason,
    ...(stopDetail !== undefined ? { stopDetail } : {}),
    stages,
    invalidFromStage: invalidFrom,
    capacity,
    firstBreach: fb,
    knee,
    ...(safetyCap ? { safetyCap } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    curves: buildCurves(stages),
    ...(environment ? { environment } : {}),
    methods: {
      stages:
        "Each stage is an independent Performance Lab run; `settle` runs at the stage level as warm-up and is excluded from metrics.",
      capacity:
        "Tested capacity = highest passing level below the lowest breaching level, among stages before any generator saturation.",
      knee: "Kneedle (S=1) on (level, corrected p95) of valid stages.",
      latency: "CO-corrected latency from HDR histograms, ms.",
    },
  };
  if (bisection) data.breakpoint = bisection;
  if (input.mode === "spike") {
    data.spike = spikeRecovery(
      stages.find((s) => s.kind === "spike-before"),
      stages.find((s) => s.kind === "spike-peak"),
      stages.find((s) => s.kind === "spike-after"),
    );
    data.methods.recovery =
      "Recovery time = seconds from spike end until the 1 s window p95 is within max(10 % , 1 ms) of the pre-spike median window p95 for 3 consecutive windows.";
  }
  if (input.mode === "soak") {
    const s = stages[0];
    const w = input.soak?.window ?? 10_000;
    data.soak = soakDrift(s ? s.series : [], w);
    data.methods.drift =
      "Theil–Sen slope of bucketed p95 over time with Sen's 95% CI; CUSUM (k=0.5, h=5) change points.";
    limitations.push({
      code: "STRESS-SOAK-NO-MEMORY",
      message: "Server memory is not observed by the HTTP-only soak; only latency drift is analysed.",
      impact: "informational",
    });
  }
  if (input.usl && (input.mode === "step" || input.mode === "ramp" || input.mode === "breakpoint")) {
    data.usl = uslFor(uncapped, lt);
  }

  const findings = buildFindings(data, ctx, runId, input);
  const userCancelled = ctx.signal.aborted || ctx.safety.killSwitch.aborted;
  const finalStop = stopReason as StressStopReason; // assigned inside closures; defeat narrowing
  let status: EngineResult["status"];
  if (userCancelled || finalStop === "cancelled") status = "cancelled";
  else if (stages.length === 0 || (finalStop === "error" && stages.every((s) => s.status === "error")))
    status = "error";
  else if (fb && input.mode !== "breakpoint") status = "failed";
  else status = "passed";
  return {
    schemaVersion: 1,
    engine: "stress",
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

/** Perf limitation codes that mean the Safety Guard stopped the stage (→ exit 3). */
const SAFETY_STAGE_CODES = new Set(["dns-rebind"]);
/** Perf limitation codes that mean the target, not SECOND WORLD, made the stage unmeasurable (→ exit 5). */
const TARGET_STAGE_CODES = new Set(["target-unreachable", "no-measurements"]);

/**
 * Why every stage ended with status "error", as run-level limitations the verdict understands
 * (docs/03-engines/stress-capacity-lab.md §7). Returns [] when a stage errored for a reason that is
 * neither the target nor the Safety Guard: that stays an engine error (exit 70).
 */
export function allErroredLimitations(
  stageLims: readonly (readonly Limitation[])[],
  target: string,
  unreachable: boolean,
): Limitation[] {
  const t = target || "the target";
  const safety = stageLims.flat().find((l) => l.impact === "invalidates" && SAFETY_STAGE_CODES.has(l.code));
  if (safety) return [{ ...safety, message: `Stopped by the Safety Guard: ${safety.message}` }];
  if (unreachable) {
    return [
      {
        code: "target-unreachable",
        message: `Every stage failed to connect to ${t}. Is it running?`,
        impact: "invalidates",
      },
    ];
  }
  const targetSide =
    stageLims.length > 0 &&
    stageLims.every((ls) => ls.some((l) => l.impact === "invalidates" && TARGET_STAGE_CODES.has(l.code)));
  if (!targetSide) return [];
  return [
    {
      code: "no-measurements",
      message: `No stage completed a measurable request against ${t} (every request timed out or never finished inside the stage). Check that the target answers within \`timeout\`, or lengthen \`hold\`.`,
      impact: "invalidates",
    },
  ];
}

function buildFindings(data: StressData, ctx: EngineContext, runId: string, input: StressInput): Finding[] {
  const out: Finding[] = [];
  const unit = data.loadType === "vus" ? "VUs" : "rps";
  const fctx = { newId: ctx.newId, clock: ctx.clock };
  const affected = data.target ? [data.target] : [];
  const fb = data.firstBreach;
  if (fb) {
    const st = data.stages.find((s) => s.index === fb.stageIndex);
    out.push(
      createFinding(
        {
          engine: "stress",
          ruleId: "STRESS-FIRST-BREACH",
          category: "capacity",
          title: `${fb.expression} first breached at ${fb.level} ${unit}`,
          description: `${data.capacity.statement} The first breaching stage was ${fb.level} ${unit} (metric ${fb.metric}${fb.actual !== null ? `, actual ${fb.actual}` : ""}).`,
          severity: input.mode === "breakpoint" ? "low" : "high",
          classification: "threshold-breach",
          confidence: 0.9,
          evidence: [
            fb.threshold !== null && fb.actual !== null
              ? { kind: "threshold", expression: fb.expression, actual: fb.actual, passed: false }
              : { kind: "note", text: fb.expression },
            {
              kind: "measurement",
              metric: "http.p95",
              value: st?.latency.p95 ?? 0,
              unit: "ms",
              runId: st?.perfRunId ?? runId,
            },
          ],
          affected,
          recommendation:
            "Treat the tested capacity as the load limit for this environment; profile the service at the breaching load.",
          tags: ["stress", data.mode],
        },
        fctx,
      ),
    );
  }
  if (data.knee) {
    out.push(
      createFinding(
        {
          engine: "stress",
          ruleId: "STRESS-KNEE",
          category: "capacity",
          title: `Latency inflection around ${data.knee.level} ${unit}`,
          description: `Kneedle detected a knee in p95 vs load at ${data.knee.level} ${unit} (p95 ${data.knee.p95} ms, strength ${data.knee.strength.toFixed(2)}).`,
          severity: "info",
          classification: "observation",
          confidence: 0.7,
          evidence: [{ kind: "measurement", metric: "http.p95", value: data.knee.p95, unit: "ms", runId }],
          affected,
          tags: ["stress", "knee"],
        },
        fctx,
      ),
    );
  }
  if (data.spike) {
    const s = data.spike;
    out.push(
      createFinding(
        {
          engine: "stress",
          ruleId: "STRESS-SPIKE-RECOVERY",
          category: "reliability",
          title: s.recovered
            ? `Recovered from spike in ${s.recoveryTimeS} s`
            : "Did not recover from spike within the observation window",
          description: `Pre-spike p95 ${s.baselineP95 ?? "n/a"} ms, spike p95 ${s.peakP95 ?? "n/a"} ms, tolerance ${s.toleranceMs.toFixed(2)} ms.`,
          severity: s.recovered ? "info" : "medium",
          classification: "observation",
          confidence: 0.8,
          evidence: [
            {
              kind: "measurement",
              metric: "spike.recovery_time",
              value: s.recoveryTimeS ?? -1,
              unit: "s",
              runId,
            },
          ],
          affected,
          tags: ["stress", "spike"],
        },
        fctx,
      ),
    );
  }
  if (data.soak?.drift && data.soak.p95SlopeMsPerHour !== null && data.soak.ci95) {
    const s = data.soak;
    out.push(
      createFinding(
        {
          engine: "stress",
          ruleId: "STRESS-SOAK-DRIFT",
          category: "performance",
          title: `Latency drift +${(s.p95SlopeMsPerHour ?? 0).toFixed(2)} ms/h during soak`,
          description: `Theil–Sen slope of p95 over time ${(s.p95SlopeMsPerHour ?? 0).toFixed(3)} ms/h, 95% CI [${s.ci95?.[0].toFixed(3)}, ${s.ci95?.[1].toFixed(3)}]; ${s.changePoints.length} CUSUM change point(s).`,
          severity: "medium",
          classification: "observation",
          confidence: 0.8,
          evidence: [
            {
              kind: "comparison",
              metric: "http.p95.slope_ms_per_h",
              change: s.p95SlopeMsPerHour ?? 0,
              ci95: s.ci95 ?? [0, 0],
            },
          ],
          affected,
          tags: ["stress", "soak"],
        },
        fctx,
      ),
    );
  }
  return out;
}
