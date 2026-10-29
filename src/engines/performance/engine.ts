/**
 * Performance Lab run loop. See docs/03-engines/performance-lab.md (all sections),
 * docs/04-data-structures-and-algorithms.md §3, docs/05-optimization.md §2.
 *
 * Timeline (ms from t0): [0, warmup) warm-up (excluded from metrics) → [warmup, warmup+duration)
 * measured window → graceful-stop drain. Ramp-up starts at t0.
 *
 * Split in two layers so worker_threads shards (§7, sharded.ts / worker.ts) reuse the exact same
 * request logic: `runLoad` drives one generator (scheduler + executor + metrics + per-generator
 * self-check) and `finalizePerformance` turns (possibly merged) metrics into the EngineResult.
 */

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import os from "node:os";
import {
  createUndiciExecutor,
  type ExecutorSafety,
  type HttpExecutor,
} from "../../adapters/http/undici-executor.js";
import type { ThresholdEntry } from "../../core/config/thresholds.js";
import { SafetyError } from "../../core/errors.js";
import type { EngineResult, Finding, Limitation } from "../../core/evidence/schemas.js";
import { createRng } from "../../core/rng.js";
import type { BudgetLease, Clock, EngineContext, Rng } from "../../core/types.js";
import type { LatencySummary } from "../../shared/stats/hdr.js";
import { type LatencyPair, PerfMetrics, PhaseStats, toMs } from "./metrics.js";
import {
  type CompiledPlan,
  checkResponse,
  compilePlan,
  type DataFeeder,
  loadData,
  pickScenario,
  renderRequest,
} from "./prepare.js";
import { runClosed, vuStartOffset } from "./scheduler/closed.js";
import { runIterations } from "./scheduler/iterations.js";
import { expectedArrivals, runOpenSchedule } from "./scheduler/open.js";
import type { PerformanceInput } from "./schema.js";
import {
  evaluateGeneratorHealth,
  type GeneratorHealth,
  GeneratorMonitor,
  InFlightIntegrator,
} from "./self-check.js";
import { effectiveWorkers, resolveWorkers } from "./shard.js";
import type { TemplateScope } from "./templates.js";
import {
  evaluateThresholds,
  parseInputThresholds,
  scopeResolver,
  type ThresholdResult,
  thresholdFindings,
} from "./thresholds.js";
import type { EnvironmentFingerprint, LatencyPairSummary, PerformanceData, SeriesPoint } from "./types.js";

export const ENGINE_VERSION = "0.1.0";

export interface PerformanceDeps {
  /** Inject a transport (tests). Default: undici executor. Forces a single generator thread. */
  executor?: HttpExecutor;
  /** Busy-wait window for the open scheduler (default: 16 ms on Windows, 2 ms elsewhere). */
  spinMs?: number;
  /** perf.tick interval in ms (default 1000). */
  tickMs?: number;
  /** Working directory for data files. */
  cwd?: string;
  /** Minimum interval between DNS re-checks of one host (F6, default 10 s; tests use less). */
  dnsRecheckIntervalMs?: number;
  /** worker_threads sharding: grace (ms) given to workers to report after a stop before they are terminated (default 2000). */
  workerTerminateGraceMs?: number;
}

export type StopReason = PerformanceData["window"]["stopReason"];
export interface SafetyAbortInfo {
  code: string;
  message: string;
}
export type StopFn = (reason: StopReason, opts?: { hard?: boolean; safetyAbort?: SafetyAbortInfo }) => void;

export function pairSummary(p: LatencyPair): LatencyPairSummary {
  return { corrected: toMs(p.corrected.summary()), raw: toMs(p.raw.summary()) };
}

function recordOf<K extends string | number>(m: Map<K, number>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const [k, v] of [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
    o[String(k)] = v;
  return o;
}

function thinkSampler(t: PerformanceInput["thinkTime"], rng: Rng): { sample: () => number; mean: number } {
  if (typeof t === "number") return { sample: () => t, mean: t };
  if ("dist" in t) return { sample: () => rng.exponential(t.mean), mean: t.mean };
  const lo = Math.min(t.min, t.max);
  const hi = Math.max(t.min, t.max);
  return { sample: () => lo + rng.next() * (hi - lo), mean: (lo + hi) / 2 };
}

async function fingerprint(target: URL): Promise<EnvironmentFingerprint> {
  const cpus = os.cpus();
  const fp: EnvironmentFingerprint = {
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpus: cpus.length,
    cpuModel: cpus[0]?.model.trim() ?? "unknown",
    node: process.version,
    targetHost: target.host,
  };
  const host = target.hostname.replace(/^\[|\]$/g, "");
  try {
    const r = await Promise.race([
      lookup(host),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), 1000).unref()),
    ]);
    fp.targetResolvedIp = r.address;
  } catch {
    // leave undefined
  }
  return fp;
}

export function checkSafety(ctx: EngineContext, input: PerformanceInput, origins: string[]): void {
  const target = new URL(input.target);
  const allowed = new Set([target.hostname.toLowerCase(), ...input.allowHosts.map((h) => h.toLowerCase())]);
  const urls = [target, ...origins.map((o) => new URL(o))];
  for (const u of urls) {
    if (!allowed.has(u.hostname.toLowerCase())) {
      throw new SafetyError(
        "SW_SAFETY_HOST_NOT_ALLOWED",
        `Host "${u.hostname}" is not the target host and not in allowHosts`,
        {
          hint: "Add it to performance.allowHosts (and the safety allow-list) if it is intended",
          details: { target: u.origin },
        },
      );
    }
    const d = ctx.safety.checkTarget(u);
    if (!d.allowed) {
      const code = (
        d.code.startsWith("SW_SAFETY_") ? d.code : `SW_SAFETY_${d.code}`
      ) as `SW_SAFETY_${string}`;
      ctx.safety.audit({ action: "performance.blocked", target: u.origin, detail: { code: d.code } });
      throw new SafetyError(code, d.reason, { hint: d.hint, details: { target: u.origin } });
    }
  }
}

export function defaultConnections(input: PerformanceInput, maxInFlight: number): number {
  if (input.http.connections !== undefined) return input.http.connections;
  if (input.model === "open") return Math.min(maxInFlight, 1024);
  return input.vus ?? 10;
}

export function defaultMaxInFlight(input: PerformanceInput, safetyCap: number | undefined): number {
  if (input.maxInFlight !== undefined) return input.maxInFlight;
  const rate = input.rate ?? 100;
  // A server that holds every request until timeout needs rate × timeout slots.
  const wanted = Math.max(64, Math.min(10_000, Math.ceil(((rate * input.timeout) / 1000) * 1.1)));
  return safetyCap !== undefined && safetyCap > 0 ? Math.min(wanted, safetyCap) : wanted;
}

/** Root RNG of a run: the input seed, else the context RNG. */
export function runRootRng(input: PerformanceInput, ctx: EngineContext): Rng {
  return input.seed !== undefined ? createRng(input.seed) : ctx.rng;
}

/** Common pre-run setup shared by the single-thread and the sharded path. */
export interface RunPreamble {
  startedAt: string;
  runId: string;
  limitations: Limitation[];
  target: URL;
  plan: CompiledPlan;
  thresholdEntries: ThresholdEntry[];
  maxInFlight: number;
  connections: number;
  totalMs: number;
  /** min(budget.maxRps, safety.maxRps), +∞ when neither is set. */
  vuRpsCap: number;
  lease: BudgetLease;
  /** Closed/iterations: the rate cap requests wait for (null = none). */
  throttleCap: number | null;
}

export function prepareRun(input: PerformanceInput, ctx: EngineContext): RunPreamble {
  const clock = ctx.clock;
  const startedAt = clock.isoNow();
  const runId = ctx.newId();
  const limitations: Limitation[] = [];
  const target = new URL(input.target);
  const plan = compilePlan(input);
  checkSafety(ctx, input, plan.origins);
  const thresholdEntries: ThresholdEntry[] = parseInputThresholds(input.thresholds);
  if (input.warmupIgnoredMs !== undefined) {
    limitations.push({
      code: "warmup-ignored-iterations",
      message: `warmup (${input.warmupIgnoredMs} ms) is ignored by the iterations model: all ${input.iterations} iterations are measured.`,
      impact: "informational",
    });
  }
  if (input.http.version === "2" && target.protocol !== "https:") {
    limitations.push({
      code: "h2-requires-tls",
      message: "HTTP/2 needs https (ALPN); using HTTP/1.1.",
      impact: "informational",
    });
  }
  const safetyCfg = (ctx.safety as { config?: { maxConcurrency?: number } }).config;
  const maxInFlight = defaultMaxInFlight(input, safetyCfg?.maxConcurrency);
  const connections = defaultConnections(input, maxInFlight);
  const totalMs = input.warmup + input.duration;
  // docs/11 §1: every request passes the lease's GCRA at min(safety.maxRps, budget.maxRps).
  // Open model: the rate itself is reserved (refused up front when above the ceiling).
  // Closed/iterations: VUs wait for a token at the cap instead of being refused.
  const safetyMaxRps = (ctx.safety as { config?: { maxRps?: number } }).config?.maxRps;
  const vuRpsCap = Math.min(
    input.budget.maxRps ?? Number.POSITIVE_INFINITY,
    safetyMaxRps ?? Number.POSITIVE_INFINITY,
  );
  const lease: BudgetLease = ctx.safety.reserve({
    ...(input.model === "open"
      ? { maxRps: input.rate as number }
      : Number.isFinite(vuRpsCap)
        ? { maxRps: vuRpsCap }
        : {}),
    maxConcurrency: input.model === "open" ? maxInFlight : (input.vus ?? 10),
    ...(input.budget.maxRequests !== undefined ? { maxRequests: input.budget.maxRequests } : {}),
    maxDurationMs: Math.min(
      input.budget.maxDuration ?? Number.POSITIVE_INFINITY,
      totalMs + input.gracefulStop + 5_000,
    ),
  });
  const leaseRps = (lease as { limits?: { maxRps?: number } }).limits?.maxRps ?? vuRpsCap;
  const throttleCap = input.model !== "open" && Number.isFinite(leaseRps) && leaseRps > 0 ? leaseRps : null;
  return {
    startedAt,
    runId,
    limitations,
    target,
    plan,
    thresholdEntries,
    maxInFlight,
    connections,
    totalMs,
    vuRpsCap,
    lease,
    throttleCap,
  };
}

// ------------------------------------------------------------------ one generator

/** This generator's share of a sharded run (docs/03-engines/performance-lab.md §7). */
export interface ShardSpec {
  count: number;
  index: number;
  /** Global VU count (closed/iterations), so local VUs keep their place on the global ramp. */
  totalVus: number;
}

export interface TickPayload {
  elapsedS: number;
  phase: "warmup" | "measure" | "drain";
  rps: number;
  p95: number;
  p99: number;
  errors: number;
  totalErrors: number;
  requests: number;
  inFlight: number;
}

export interface TickInfo {
  now: number;
  payload: TickPayload;
  metrics: PerfMetrics;
  measureStart: number;
  stopped: boolean;
  stop: StopFn;
}

export interface LoadSetup {
  /** Input of this generator: `vus`/`iterations` are already this shard's share; `rate` stays global. */
  input: PerformanceInput;
  plan: CompiledPlan;
  feeder: DataFeeder | null;
  clock: Clock;
  rootRng: Rng;
  executor: HttpExecutor;
  phaseStats: PhaseStats | null;
  /** This generator's in-flight cap (open model). */
  maxInFlight: number;
  connections: number;
  spinMs: number;
  tickMs: number;
  /** Budget check before each request (lease.take or a shard quota). */
  take(): boolean;
  /** Closed/iterations rate cap: resolves true when the cap delayed the call. */
  throttle: ((signal: AbortSignal) => Promise<boolean>) | null;
  /** Clock ms used as t0 (default: clock.now()). Shards share one absolute start. */
  t0?: number;
  shard?: ShardSpec;
  /** Subscribes external stop sources (cancel, kill switch, lease, main thread); returns the unsubscribe. */
  bindStop(stop: StopFn): () => void;
  /** Called after a stop decided inside this generator (budget / data exhausted, threshold abort). */
  onStop?(reason: StopReason): void;
  onTick(t: TickInfo): void;
}

export interface LoadOutcome {
  metrics: PerfMetrics;
  t0: number;
  stopReason: StopReason;
  /** Measured window length (ms) as seen by this generator. */
  measuredMs: number;
  iterationsDone: number;
  throttledWaits: number;
  gracefulExpired: boolean;
  safetyAbort: SafetyAbortInfo | null;
  targetRate?: number;
  achievedRate?: number;
  /** Generator self-check of THIS generator (§6). */
  health: { health: GeneratorHealth; limitations: Limitation[] };
}

/** Drives one generator: scheduler + executor + metrics + self-check. The caller closes nothing. */
export async function runLoad(s: LoadSetup): Promise<LoadOutcome> {
  const { input, plan, feeder, clock, executor, phaseStats } = s;
  const rootRng = s.rootRng;
  const arrivalsRng = rootRng.fork("arrivals");
  const thinkRng = rootRng.fork("think");
  const templateRng = rootRng.fork("templates");
  const pickRng = rootRng.fork("scenarios");
  const reservoirRng = rootRng.fork("reservoir");
  const think = thinkSampler(input.thinkTime, thinkRng);
  const shardCount = s.shard?.count ?? 1;
  const shardIndex = s.shard?.index ?? 0;
  const totalMs = input.warmup + input.duration;
  const throttle = s.throttle;
  let throttledWaits = 0;

  // ---- control
  const stopCtl = new AbortController(); // stop scheduling new work
  const hardCtl = new AbortController(); // abort in-flight requests
  const run = { stopReason: "completed" as StopReason, stopAt: null as number | null };
  let inflight: InFlightIntegrator | undefined;
  let safetyAbort: SafetyAbortInfo | null = null;
  const stopOnly = (
    reason: StopReason,
    opts?: { hard?: boolean; safetyAbort?: SafetyAbortInfo },
  ): boolean => {
    if (opts?.safetyAbort && safetyAbort === null) safetyAbort = opts.safetyAbort;
    if (opts?.hard) hardCtl.abort();
    if (stopCtl.signal.aborted) return false;
    run.stopReason = reason;
    run.stopAt = clock.now();
    inflight?.setWindowEnd(run.stopAt);
    stopCtl.abort();
    return true;
  };
  /** External stop (bound sources): no echo to onStop. */
  const stopExternal: StopFn = (reason, opts) => {
    stopOnly(reason, opts);
  };
  /** Stop decided by this generator: reported to onStop (sharding broadcasts it). */
  const stop: StopFn = (reason, opts) => {
    if (stopOnly(reason, opts)) s.onStop?.(reason);
  };
  const unbind = s.bindStop(stopExternal);

  const t0 = s.t0 ?? clock.now();
  const measureStart = t0 + input.warmup;
  const scheduledEnd = t0 + totalMs;
  const metrics = new PerfMetrics({
    startMs: t0,
    warmupEndMs: measureStart,
    random: () => reservoirRng.next(),
  });
  metrics.phases = phaseStats;
  inflight = new InFlightIntegrator(measureStart, scheduledEnd);
  if (run.stopAt !== null) inflight.setWindowEnd(run.stopAt);
  const inflightRef = inflight;
  const monitor = new GeneratorMonitor(() => clock.now());
  monitor.start();
  // Template `seq` is unique across shards: shard k yields k+1, k+1+N, …
  let seq = shardIndex + 1 - shardCount;
  let iterationsDone = 0;
  const vuCycle: number[] = [];

  // ---- one scenario iteration
  const iteration = async (intendedMs: number | undefined, vu: number | undefined): Promise<void> => {
    const sc = pickScenario(plan, pickRng);
    let row: Record<string, string | number | boolean> | undefined;
    if (feeder) {
      const r = feeder.next(templateRng);
      if (r === null) {
        stop("data-exhausted");
        return;
      }
      row = r;
    }
    const scope: TemplateScope = {
      rng: templateRng,
      vars: {},
      row,
      nextSeq: () => {
        seq += shardCount;
        return seq;
      },
      epochMs: () => Date.now(),
    };
    const iterStart = intendedMs ?? clock.now();
    const expectedInterval = vu !== undefined ? vuCycle[vu] : undefined;
    let iterOk = true;
    let first = true;
    let interrupted = false;
    for (const step of sc.steps) {
      if (hardCtl.signal.aborted) {
        interrupted = true;
        break;
      }
      if (!s.take()) {
        metrics.budgetRefused++;
        stop("budget-exhausted");
        interrupted = true;
        break;
      }
      if (throttle) {
        try {
          // Waiting for a token happens before the request starts: it is not latency.
          // Count only waits the GCRA actually imposed (wall-clock deltas misfire under event-loop lag).
          if (await throttle(stopCtl.signal)) throttledWaits++;
        } catch {
          interrupted = true;
          break;
        }
        // A VU that got its token only after the schedule ended must not start a new iteration
        // (that would inflate the measured window with post-deadline requests).
        if (first && clock.now() >= scheduledEnd) {
          interrupted = true;
          break;
        }
      }
      const req = renderRequest(step, scope);
      inflightRef.start(clock.now());
      const res = await executor.execute(req, hardCtl.signal);
      inflightRef.end(clock.now());
      if (res.error?.kind === "aborted") {
        metrics.recordInterrupted();
        interrupted = true;
        break;
      }
      const outcome = res.error
        ? ({ ok: false, kind: res.error.kind, message: res.error.message } as const)
        : checkResponse(step, res, scope.vars);
      metrics.record({
        endpoint: step.key,
        scenario: sc.name,
        method: step.method,
        path: step.pathTemplate,
        startMs: res.tStart,
        intendedMs: first && intendedMs !== undefined ? Math.min(intendedMs, res.tStart) : res.tStart,
        headersMs: res.tHeaders,
        endMs: res.tEnd,
        expectedIntervalMs: expectedInterval !== undefined ? Math.max(1, expectedInterval) : undefined,
        status: res.status,
        ok: outcome.ok,
        errorKind: outcome.ok ? undefined : outcome.kind,
        message: outcome.ok ? undefined : outcome.message,
        bytesIn: res.bytesIn,
        bytesOut: res.bytesOut,
        phases: res.phases,
      });
      first = false;
      if (!outcome.ok) {
        iterOk = false;
        break;
      }
    }
    if (interrupted) return;
    const end = clock.now();
    iterationsDone++;
    metrics.recordIteration(sc.name, iterStart, end, iterOk);
    if (vu !== undefined) {
      // Closed-model CO correction: expected interval = EWMA of this VU's cycle (iteration + think).
      const cycle = end - iterStart + think.mean;
      const prev = vuCycle[vu];
      vuCycle[vu] = prev === undefined ? cycle : prev + 0.1 * (cycle - prev);
    }
  };

  // ---- ticks: live events, abortOnFail thresholds (caller), generator sampling
  let lastTickRequests = 0;
  let lastTickFailed = 0;
  let lastTickAt = t0;
  const tick = setInterval(() => {
    const now = clock.now();
    metrics.series.flush(now - t0);
    const dt = Math.max(0.001, (now - lastTickAt) / 1000);
    const last = metrics.series.lastClosed();
    const reqs = metrics.requests + metrics.warmupRequests;
    const payload: TickPayload = {
      elapsedS: Math.round((now - t0) / 100) / 10,
      phase:
        now < measureStart ? "warmup" : now < scheduledEnd && !stopCtl.signal.aborted ? "measure" : "drain",
      rps: Math.round(((reqs - lastTickRequests) / dt) * 10) / 10,
      p95: last?.summary ? Math.round(last.summary.p95) / 1000 : 0,
      p99: last?.summary ? Math.round(last.summary.p99) / 1000 : 0,
      errors: metrics.failed - lastTickFailed,
      totalErrors: metrics.failed,
      requests: reqs,
      inFlight: executor.inFlight,
    };
    lastTickRequests = reqs;
    lastTickFailed = metrics.failed;
    lastTickAt = now;
    s.onTick({ now, payload, metrics, measureStart, stopped: stopCtl.signal.aborted, stop });
  }, s.tickMs);
  tick.unref?.();
  const sampler = setInterval(() => {
    const now = clock.now();
    if (now >= measureStart && now < scheduledEnd && !stopCtl.signal.aborted) {
      monitor.sampleSockets(executor.openSockets);
    }
  }, 100);
  sampler.unref?.();

  // ---- graceful-stop watchdog: once scheduling ends, in-flight work gets gracefulStop ms.
  const doneCtl = new AbortController();
  let gracefulExpired = false;
  const watchdog = (async () => {
    const wake = AbortSignal.any([stopCtl.signal, doneCtl.signal]);
    try {
      await clock.sleep(Math.max(0, scheduledEnd - clock.now()), wake);
    } catch {
      // stopped early or done
    }
    if (doneCtl.signal.aborted) return;
    try {
      await clock.sleep(input.gracefulStop, doneCtl.signal);
    } catch {
      return;
    }
    if (!doneCtl.signal.aborted) {
      gracefulExpired = true;
      hardCtl.abort();
    }
  })();

  // ---- run the model
  let targetRate: number | undefined;
  let achievedRate: number | undefined;
  let lagP99Ms = 0;
  let lagSamples = 0;
  let lagMaxMs = 0;
  let spinMs = 0;
  let dropped = 0;
  let measuredReleased = 0;
  const vus = input.vus ?? 10;
  const totalVus = s.shard?.totalVus ?? vus;
  // Local VU j of shard k is global VU j·N + k: the global ramp-up is preserved across shards.
  const startOffset =
    shardCount > 1
      ? (i: number): number => vuStartOffset(i * shardCount + shardIndex, totalVus, input.rampUp)
      : undefined;
  try {
    if (input.model === "open") {
      const rate = input.rate as number;
      const r = await runOpenSchedule({
        rate,
        arrival: input.arrival,
        rampUpMs: input.rampUp,
        totalMs,
        rng: arrivalsRng,
        ...(shardCount > 1 ? { shard: { count: shardCount, index: shardIndex } } : {}),
        clock,
        signal: stopCtl.signal,
        maxInFlight: s.maxInFlight,
        spinMs: s.spinMs,
        t0,
        onArrival: (intended) => {
          if (intended >= measureStart) measuredReleased++;
          return iteration(intended, undefined);
        },
        onDrop: (intended) => {
          if (intended >= measureStart) metrics.dropped++;
        },
      });
      await Promise.all([...r.pending]);
      dropped = r.dropped;
      lagP99Ms = r.lag.percentile(99) / 1000;
      lagSamples = r.lag.count;
      lagMaxMs = r.lag.max / 1000;
      spinMs = r.spinMs;
      const measEnd = Math.min(scheduledEnd, run.stopAt ?? Number.POSITIVE_INFINITY);
      const windowS = Math.max(0.001, (measEnd - measureStart) / 1000);
      targetRate =
        expectedArrivals({ rate, rampUpMs: input.rampUp }, input.warmup, measEnd - t0) / windowS / shardCount;
      achievedRate = measuredReleased / windowS;
    } else if (input.model === "iterations") {
      await runIterations({
        iterations: input.iterations as number,
        vus,
        rampUpMs: input.rampUp,
        totalMs,
        clock,
        signal: stopCtl.signal,
        t0,
        think: think.sample,
        iteration: (vu) => iteration(undefined, vu),
        ...(startOffset ? { startOffset } : {}),
      });
    } else {
      await runClosed({
        vus,
        rampUpMs: input.rampUp,
        totalMs,
        clock,
        signal: stopCtl.signal,
        t0,
        think: think.sample,
        iteration: (vu) => iteration(undefined, vu),
        ...(startOffset ? { startOffset } : {}),
      });
    }
  } finally {
    doneCtl.abort();
    await watchdog;
    clearInterval(tick);
    clearInterval(sampler);
    unbind();
  }
  const endClock = clock.now();
  const gen = monitor.stop();
  metrics.series.closeAll();

  // ---- measured window
  let measuredEnd: number;
  if (input.model === "iterations" && run.stopReason === "completed") {
    measuredEnd = Math.max(measureStart, Math.min(scheduledEnd, metrics.lastEndMs || endClock));
  } else {
    measuredEnd = Math.min(scheduledEnd, run.stopAt ?? Number.POSITIVE_INFINITY, endClock);
  }
  const measuredMs = Math.max(0, measuredEnd - measureStart);
  const windowSec = Math.max(0.001, measuredMs / 1000);

  // ---- generator health (per generator: each shard checks itself)
  const g = metrics.global;
  const p50 = g.raw.percentile(50);
  const health = evaluateGeneratorHealth({
    model: input.model,
    eldP99Ms: gen.eldP99Ms,
    eldMaxMs: gen.eldMaxMs,
    cpuMs: gen.cpuMs,
    spinMs,
    wallMs: gen.wallMs,
    lagP99Ms,
    lagMaxMs,
    lagSamples,
    ...(input.model === "open" ? { intervalMs: (1000 * shardCount) / (input.rate as number) } : {}),
    ...(targetRate !== undefined ? { targetRate } : {}),
    ...(achievedRate !== undefined ? { achievedRate } : {}),
    dropped,
    meanInFlight: inflightRef.mean(measureStart + measuredMs),
    completed: metrics.requests,
    measuredMs,
    throughput: metrics.requests / windowSec,
    meanLatencyMs: g.raw.mean / 1000,
    latencyFlat: g.raw.count > 0 && g.raw.percentile(99) <= 2 * Math.max(p50, 1000),
    maxOpenSockets: monitor.maxOpenSockets,
    connections: s.connections,
  });

  return {
    metrics,
    t0,
    stopReason: run.stopReason,
    measuredMs,
    iterationsDone,
    throttledWaits,
    gracefulExpired,
    safetyAbort,
    ...(targetRate !== undefined ? { targetRate } : {}),
    ...(achievedRate !== undefined ? { achievedRate } : {}),
    health,
  };
}

// ------------------------------------------------------------------ result

/** A closed 1 s window (from one generator, or merged across shards). */
export interface WindowLite {
  startMs: number;
  ok: number;
  failed: number;
  bytes: number;
  summary: LatencySummary | null;
}

export function seriesPoints(windows: readonly WindowLite[], windowMs: number): SeriesPoint[] {
  return windows.map((w) => {
    const s = w.summary;
    const n = w.ok + w.failed;
    return {
      t: Math.round(w.startMs) / 1000,
      requests: n,
      ok: w.ok,
      failed: w.failed,
      rps: round3(n / (windowMs / 1000)),
      bytesIn: w.bytes,
      p50: s ? s.p50 / 1000 : 0,
      p95: s ? s.p95 / 1000 : 0,
      p99: s ? s.p99 / 1000 : 0,
      max: s ? s.max / 1000 : 0,
    };
  });
}

export interface FinalizeArgs {
  input: PerformanceInput;
  ctx: EngineContext;
  pre: RunPreamble;
  outcome: LoadOutcome;
  series: SeriesPoint[];
  abortedBy: ReadonlySet<string>;
  seed: number;
  /** Generators that ran (1 = in-process). */
  workers: number;
}

export async function finalizePerformance(f: FinalizeArgs): Promise<EngineResult<PerformanceData>> {
  const { input, ctx, pre, outcome } = f;
  const clock = ctx.clock;
  const { metrics, measuredMs, health } = outcome;
  const { target, runId, startedAt, connections, maxInFlight, throttleCap } = pre;
  const limitations = [...pre.limitations];
  const windowSec = Math.max(0.001, measuredMs / 1000);
  const stopReason = outcome.stopReason;

  // ---- thresholds
  const thresholdResults: ThresholdResult[] = evaluateThresholds(
    pre.thresholdEntries,
    scopeResolver(metrics, windowSec),
  );
  for (const r of thresholdResults) if (f.abortedBy.has(r.expression)) r.aborted = true;

  limitations.push(...health.limitations);
  const abortInfo = outcome.safetyAbort;
  if (abortInfo) {
    limitations.push({
      code: "dns-rebind",
      message: `Run aborted by the Safety Guard: ${abortInfo.message}`,
      impact: "invalidates",
    });
  }
  if (outcome.throttledWaits > 0 && throttleCap !== null) {
    limitations.push({
      code: "PERF-THROTTLED-BY-SAFETY",
      message: `${outcome.throttledWaits} requests waited for the safety rate cap (${throttleCap} req/s = min(safety.maxRps, budget.maxRps)); throughput reflects the cap, not the target's capacity.`,
      impact: "reduces-confidence",
    });
  }
  if (stopReason === "budget-exhausted") {
    limitations.push({
      code: "budget-exhausted",
      message: "The safety request budget was exhausted; the run stopped early.",
      impact: "reduces-confidence",
    });
  }
  if (stopReason === "data-exhausted") {
    limitations.push({
      code: "data-exhausted",
      message: "The unique data feeder ran out of rows; the run stopped early.",
      impact: "reduces-confidence",
    });
  }
  if (outcome.gracefulExpired && metrics.interrupted > 0) {
    limitations.push({
      code: "graceful-stop-expired",
      message: `${metrics.interrupted} in-flight requests were aborted after gracefulStop (${input.gracefulStop} ms).`,
      impact: "informational",
    });
  }
  const noMeasurements = metrics.requests === 0 && stopReason !== "cancelled";
  if (noMeasurements) {
    limitations.push({
      code: "no-measurements",
      message: "No request completed inside the measured window.",
      impact: "invalidates",
    });
  }
  const unreachableKinds = new Set(["econnrefused", "dns", "connect-timeout"]);
  let unreachable = 0;
  for (const [k, v] of metrics.errors) if (unreachableKinds.has(k)) unreachable += v;
  const targetUnreachable = metrics.requests > 0 && metrics.ok === 0 && unreachable === metrics.failed;
  if (targetUnreachable) {
    limitations.push({
      code: "target-unreachable",
      message: `Every request failed to connect (${[...metrics.errors.keys()].join(", ")}). Is the target running?`,
      impact: "invalidates",
    });
    // Instant connection refusals make VUs spin: the CPU is real but "generator saturated" would mislead.
    const i = limitations.findIndex((l) => l.code === "generator-saturated");
    if (i >= 0) limitations.splice(i, 1);
    health.health.saturated = false;
    health.health.reasons = [];
    health.health.remedies = [];
  }

  // ---- findings
  const window = { start: startedAt, end: clock.isoNow() };
  const confidence = health.health.saturated ? 0.6 : 0.9;
  // Nothing measured: thresholds have no data, which is an invalid run, not a breach.
  const findings: Finding[] = thresholdFindings(noMeasurements ? [] : thresholdResults, {
    newId: () => ctx.newId(),
    isoNow: () => clock.isoNow(),
    runId,
    target: target.origin,
    window,
    confidence,
    seed: input.seed,
  });
  if (abortInfo) {
    const now = clock.isoNow();
    findings.push({
      schemaVersion: 1,
      id: ctx.newId(),
      fingerprint: createHash("sha256")
        .update(`performance|dns-rebind|${target.host}`)
        .digest("hex")
        .slice(0, 32),
      engine: "performance",
      ruleId: "PERF-DNS-REBIND",
      category: "security",
      title: `DNS for ${target.hostname} changed address class mid-run; the run was aborted`,
      description: `${abortInfo.message}. Connections only ever used the addresses pinned at pre-flight; results after the change are not trustworthy.`,
      severity: "critical",
      classification: "observation",
      status: "open",
      confidence: 0.9,
      evidence: [{ kind: "note", text: `${abortInfo.code}: ${abortInfo.message}` }],
      locations: [],
      affected: [target.origin],
      recommendation: "Check the target's DNS records (possible DNS rebinding) before re-running.",
      related: [],
      occurrences: 1,
      firstSeen: now,
      lastSeen: now,
      tags: ["safety", "dns-rebind"],
    });
  }

  // ---- data
  const environment = await fingerprint(target);
  const endpoints = [...metrics.endpoints.values()].map((e) => ({
    key: e.key,
    method: e.method,
    path: e.path,
    scenario: e.scenario,
    requests: e.requests,
    ok: e.ok,
    failed: e.failed,
    timeouts: e.timeouts,
    rps: round3(e.requests / windowSec),
    errorRate: e.requests === 0 ? 0 : round6(e.failed / e.requests),
    bytesIn: e.bytesIn,
    bytesOut: e.bytesOut,
    latency: pairSummary(e.latency),
    ttfb: toMs(e.ttfb.summary()),
    status: recordOf(e.status),
    errors: recordOf(e.errors),
  }));
  const histEndpoints: Record<string, { corrected: string; raw: string }> = {};
  for (const e of metrics.endpoints.values()) {
    histEndpoints[e.key] = { corrected: e.latency.corrected.encode(), raw: e.latency.raw.encode() };
  }
  const phaseStats = metrics.phases;
  const targetRate = outcome.targetRate;
  const achievedRate = outcome.achievedRate;

  const data: PerformanceData = {
    schema: 1,
    target: input.target,
    model: input.model,
    ...(input.model === "open" ? { arrival: input.arrival } : {}),
    config: {
      ...(input.rate !== undefined ? { rate: input.rate } : {}),
      ...(input.vus !== undefined && input.model !== "open" ? { vus: input.vus } : {}),
      ...(input.iterations !== undefined ? { iterations: input.iterations } : {}),
      durationMs: input.duration,
      rampUpMs: input.rampUp,
      warmupMs: input.warmup,
      gracefulStopMs: input.gracefulStop,
      timeoutMs: input.timeout,
      connections,
      ...(input.model === "open" ? { maxInFlight } : {}),
      seed: input.seed !== undefined ? input.seed : f.seed,
      workers: f.workers,
      scenarios: input.scenarios.map((s) => ({ name: s.name, weight: s.weight, steps: s.steps.length })),
    },
    window: {
      startedAt,
      endedAt: window.end,
      measuredMs: Math.round(measuredMs),
      warmupMs: input.warmup,
      stopReason,
    },
    totals: {
      requests: metrics.requests,
      ok: metrics.ok,
      failed: metrics.failed,
      timeouts: metrics.timeouts,
      interrupted: metrics.interrupted,
      dropped: metrics.dropped,
      budgetRefused: metrics.budgetRefused,
      throttled: outcome.throttledWaits,
      iterations: outcome.iterationsDone,
      bytesIn: metrics.bytesIn,
      bytesOut: metrics.bytesOut,
      rps: round3(metrics.requests / windowSec),
      okRps: round3(metrics.ok / windowSec),
      failedRps: round3(metrics.failed / windowSec),
      errorRate: metrics.requests === 0 ? 0 : round6(metrics.failed / metrics.requests),
      timeoutRate: metrics.requests === 0 ? 0 : round6(metrics.timeouts / metrics.requests),
      ...(targetRate !== undefined ? { targetRate: round3(targetRate) } : {}),
      ...(achievedRate !== undefined ? { achievedRate: round3(achievedRate) } : {}),
    },
    latency: pairSummary(metrics.global),
    endpoints,
    scenarios: [...metrics.scenarios.values()].map((s) => ({
      name: s.name,
      iterations: s.iterations,
      ok: s.ok,
      failed: s.failed,
      requests: s.requests,
      duration: toMs(s.latency.corrected.summary()),
    })),
    status: recordOf(metrics.status),
    errors: [...metrics.errors.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => ({ kind, count })),
    errorSamples: metrics.errorReservoir.items.slice().sort((a, b) => a.tMs - b.tMs),
    firstErrors: [...metrics.firstErrors.values()],
    histograms: {
      unit: "us",
      global: { corrected: metrics.global.corrected.encode(), raw: metrics.global.raw.encode() },
      endpoints: histEndpoints,
    },
    series: f.series,
    warmup: { requests: metrics.warmupRequests, latency: pairSummary(metrics.warmup) },
    generator: health.health,
    ...(phaseStats
      ? {
          phases: {
            connections: phaseStats.connections,
            connectErrors: phaseStats.connectErrors,
            dns: toMs(phaseStats.dns.summary()),
            tcp: toMs(phaseStats.tcp.summary()),
            tls: toMs(phaseStats.tls.summary()),
            connect: toMs(phaseStats.connect.summary()),
            wait: toMs(phaseStats.wait.summary()),
            server: toMs(phaseStats.server.summary()),
            transfer: toMs(phaseStats.transfer.summary()),
          },
        }
      : {}),
    thresholds: thresholdResults,
    environment,
    methods: {
      latency:
        "corrected = t_end − t_intended_start (open model) or HdrHistogram expected-interval correction (closed model); raw = t_end − t_actual_start; performance.now() monotonic clock",
      percentiles:
        f.workers > 1
          ? `nearest-rank on HDR buckets (3 significant digits, ±0.1%); ${f.workers} worker histograms merged bucket-wise (exact, CO-corrected per worker before the merge)`
          : "nearest-rank on HDR buckets (3 significant digits, ±0.1%)",
      throughput: "completed requests / measured window (excludes warm-up and graceful-stop drain)",
      errorRate:
        "failed / completed; failed follows `expect` (default: status >= 400 or transport error); interrupted requests excluded",
      coCorrection: "always on; corrected values are the default, raw shown side by side",
    },
  };

  let status: EngineResult["status"];
  if (stopReason === "safety-abort") status = "error";
  else if (stopReason === "cancelled") status = "cancelled";
  else if (targetUnreachable || noMeasurements) status = "error";
  else if (thresholdResults.some((r) => !r.passed)) status = "failed";
  else status = "passed";

  return {
    schemaVersion: 1,
    engine: "performance",
    runId,
    status,
    startedAt,
    endedAt: window.end,
    findings,
    limitations,
    artifacts: [],
    data,
  };
}

/** abortOnFail thresholds over live metrics (evaluated by whoever owns the global view). */
export function abortCheck(
  entries: readonly ThresholdEntry[],
  metrics: PerfMetrics,
  elapsedMeasuredMs: number,
  abortedBy: Set<string>,
): boolean {
  const due = entries.filter((t) => elapsedMeasuredMs >= t.delayAbortEvalMs);
  if (due.length === 0) return false;
  const res = evaluateThresholds(due, scopeResolver(metrics, elapsedMeasuredMs / 1000));
  const failed = res.filter((r) => !r.passed && r.actual !== null);
  for (const f of failed) abortedBy.add(f.expression);
  return failed.length > 0;
}

export function defaultSpinMs(deps: PerformanceDeps): number {
  return deps.spinMs ?? (process.platform === "win32" ? 16 : 2);
}

// ------------------------------------------------------------------ entry

export async function executePerformance(
  input: PerformanceInput,
  ctx: EngineContext,
  deps: PerformanceDeps = {},
): Promise<EngineResult<PerformanceData>> {
  const requested = resolveWorkers(input.workers);
  const workers = effectiveWorkers(input, requested);
  if (workers > 1 && deps.executor === undefined) {
    const { executeSharded, resolveWorkerEntry } = await import("./sharded.js");
    const entry = resolveWorkerEntry();
    if (entry) return executeSharded(input, ctx, deps, workers, entry);
    return executeInProcess(input, ctx, deps, {
      code: "workers-unavailable",
      message: `workers: ${String(input.workers)} requested but the worker entry (perf-worker) was not found next to the engine bundle; ran a single generator thread.`,
      impact: "informational",
    });
  }
  return executeInProcess(
    input,
    ctx,
    deps,
    requested > 1
      ? {
          code: "workers-not-supported",
          message:
            workers <= 1
              ? `workers: ${String(input.workers)} requested; the load (${input.model === "open" ? "rate" : "VUs/iterations"}) is too small to split, so one generator thread ran.`
              : `workers: ${String(input.workers)} requested; an injected executor cannot be shared with worker threads, so one generator thread ran.`,
          impact: "informational",
        }
      : undefined,
  );
}

async function executeInProcess(
  input: PerformanceInput,
  ctx: EngineContext,
  deps: PerformanceDeps,
  extraLimitation: Limitation | undefined,
): Promise<EngineResult<PerformanceData>> {
  const clock = ctx.clock;
  const pre = prepareRun(input, ctx);
  if (extraLimitation) pre.limitations.unshift(extraLimitation);
  const { lease, throttleCap } = pre;
  const throttleFn =
    throttleCap !== null && "throttle" in lease
      ? (lease as BudgetLease & { throttle(s?: AbortSignal): Promise<boolean> }).throttle.bind(lease)
      : null;

  const feeder: DataFeeder | null = input.data ? await loadData(input.data, deps.cwd) : null;
  const rootRng = runRootRng(input, ctx);

  const phaseStats: PhaseStats | null = input.timing === "detailed" ? new PhaseStats() : null;
  const executor =
    deps.executor ??
    createUndiciExecutor({
      connections: pre.connections,
      keepAlive: input.http.keepAlive,
      pipelining: input.http.pipelining,
      timeoutMs: input.timeout,
      connectTimeoutMs: input.connectTimeout,
      allowH2: input.http.version === "2",
      now: () => clock.now(),
      timing: input.timing,
      // F5/F6: pinned DNS lookup, redirect checks and DNS-rebind re-checks from the Safety Guard.
      safety: ctx.safety as ExecutorSafety,
      ...(deps.dnsRecheckIntervalMs !== undefined ? { dnsRecheckIntervalMs: deps.dnsRecheckIntervalMs } : {}),
      ...(input.timing === "detailed" ? { onConnection: (t) => phaseStats?.recordConnection(t) } : {}),
    });

  // F6: a DNS rebind fires the guard's kill switch with SW_SAFETY_DNS_REBIND: that is a safety
  // abort (status "error"), not a user cancellation.
  const external = [ctx.signal, ctx.safety.killSwitch];
  const leaseSignal = (lease as { signal?: AbortSignal }).signal;
  const bindStop = (stop: StopFn): (() => void) => {
    const onCancel = (): void => {
      const reason: unknown = ctx.safety.killSwitch.aborted ? ctx.safety.killSwitch.reason : undefined;
      const execErr = executor.safetyError;
      if (isRebind(reason) || isRebind(execErr)) {
        const info = isRebind(reason) ? reason : (execErr as unknown as SafetyAbortInfo);
        stop("safety-abort", { hard: true, safetyAbort: { code: info.code, message: info.message } });
        return;
      }
      stop("cancelled");
    };
    const onLeaseAbort = (): void => {
      if (ctx.signal.aborted || ctx.safety.killSwitch.aborted) onCancel();
      else stop("budget-exhausted");
    };
    for (const s of external) {
      if (s.aborted) onCancel();
      else s.addEventListener("abort", onCancel, { once: true });
    }
    if (leaseSignal) leaseSignal.addEventListener("abort", onLeaseAbort, { once: true });
    return () => {
      for (const s of external) s.removeEventListener("abort", onCancel);
      if (leaseSignal) leaseSignal.removeEventListener("abort", onLeaseAbort);
    };
  };

  const abortEntries = pre.thresholdEntries.filter((t) => t.abortOnFail);
  const abortedBy = new Set<string>();
  let outcome: LoadOutcome;
  try {
    outcome = await runLoad({
      input,
      plan: pre.plan,
      feeder,
      clock,
      rootRng,
      executor,
      phaseStats,
      maxInFlight: pre.maxInFlight,
      connections: pre.connections,
      spinMs: defaultSpinMs(deps),
      tickMs: deps.tickMs ?? 1000,
      take: () => lease.take(),
      throttle: throttleFn,
      bindStop,
      onTick: (t) => {
        ctx.events.emit("perf.tick", { runId: pre.runId, ...t.payload });
        if (abortEntries.length > 0 && t.now >= t.measureStart && !t.stopped) {
          if (abortCheck(abortEntries, t.metrics, t.now - t.measureStart, abortedBy))
            t.stop("threshold-abort");
        }
      },
    });
  } finally {
    await executor.close();
    lease.release();
  }
  const metrics = outcome.metrics;
  return finalizePerformance({
    input,
    ctx,
    pre,
    outcome,
    series: seriesPoints(metrics.series.closed(), metrics.series.windowMs),
    abortedBy,
    seed: rootRng.seed,
    workers: 1,
  });
}

export function isRebind(e: unknown): e is SafetyAbortInfo {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "SW_SAFETY_DNS_REBIND";
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
