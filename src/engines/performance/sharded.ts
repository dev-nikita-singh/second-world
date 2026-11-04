/**
 * worker_threads sharding, main-thread side. See docs/03-engines/performance-lab.md §7 and
 * docs/05-optimization.md (scaling the generator).
 *
 * The main thread keeps everything global: the safety pre-checks and the budget lease, the kill
 * switch / cancellation (broadcast to every worker, which are terminated if they do not report
 * within a grace period), the Safety Guard hooks (DNS pinning, re-checks, redirect checks are RPCs
 * answered here), abortOnFail thresholds (evaluated on merged live snapshots) and the final result.
 * Each worker runs the in-process generator (`runLoad`) on its share and returns HDR histograms
 * that are merged bucket-wise (exact). Live perf.tick p95/p99 are exact too: the workers' newest closed
 * 1 s window histograms are HDR-added once per window (tick-merge.ts). CO correction and the generator self-check happen per worker.
 *
 * Rate caps: a closed/iterations rate cap (min(safety.maxRps, budget.maxRps)) becomes a GCRA at
 * cap/N in every worker. With an uneven VU split the total can stay below the cap (limitation).
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { LookupFunction } from "node:net";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { EngineResult, Limitation } from "../../core/evidence/schemas.js";
import type { EngineContext, SafetyDecision } from "../../core/types.js";
import {
  abortCheck,
  defaultSpinMs,
  finalizePerformance,
  isRebind,
  type LoadOutcome,
  type PerformanceDeps,
  prepareRun,
  runRootRng,
  type SafetyAbortInfo,
  type StopReason,
  seriesPoints,
  type TickPayload,
} from "./engine.js";
import type { PerformanceInput } from "./schema.js";
import type { GeneratorHealth } from "./self-check.js";
import { type MetricsSnapshot, mergeSnapshots, planShards } from "./shard.js";
import { TickWindowMerger } from "./tick-merge.js";
import type { PerformanceData } from "./types.js";
import {
  type MainToWorker,
  type OutcomeSnapshot,
  type RpcError,
  type RpcRequest,
  WORKER_KIND,
  type WorkerInit,
  type WorkerToMain,
} from "./worker-protocol.js";

export interface WorkerEntry {
  url: URL;
  execArgv?: string[];
  /**
   * TS sources only: inline bootstrap (run with `eval: true`) that registers tsx through its API inside the
   * worker and then imports `url`. Node 22 does not apply `--import tsx` loader hooks in a worker thread
   * (verified on 22.19: ".js" imports of ".ts" files fail to resolve); Node 24 does. Built dist never uses it.
   */
  bootstrap?: string;
}

function tsxLoaderUrl(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return pathToFileURL(req.resolve("tsx")).href;
  } catch {
    return null;
  }
}

/** The tsx register() API (ESM build), for the worker bootstrap. */
function tsxApiUrl(): string | null {
  try {
    const cjs = createRequire(import.meta.url).resolve("tsx/esm/api");
    const mjs = cjs.replace(/\.cjs$/, ".mjs");
    return pathToFileURL(existsSync(mjs) ? mjs : cjs).href;
  } catch {
    return null;
  }
}

function fileExists(url: URL): boolean {
  try {
    return url.protocol === "file:" && existsSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

/**
 * Locates the worker entry next to this module:
 * - TS sources (vitest / tsx): `worker.ts`, loaded with the tsx loader (`--import tsx`);
 * - built dist (tsdown): the `perf-worker` entry beside the chunk (or one directory up);
 * - tsc-style output: `worker.js` beside `sharded.js`.
 * Returns null when no runnable entry exists (the engine then runs in-process with a limitation).
 */
export function resolveWorkerEntry(here: string | undefined = import.meta.url): WorkerEntry | null {
  if (typeof here !== "string" || here === "") return null;
  if (/\.[cm]?ts$/.test(here)) {
    const url = new URL("./worker.ts", here);
    const tsx = tsxLoaderUrl();
    const api = tsxApiUrl();
    if (!tsx || !api || !fileExists(url)) return null;
    const bootstrap = `import(${JSON.stringify(api)}).then((m) => { m.register(); return import(${JSON.stringify(url.href)}); });`;
    return { url, execArgv: ["--import", tsx], bootstrap };
  }
  const ext = here.endsWith(".cjs") ? ["cjs"] : ["js", "mjs"];
  const candidates = ext.flatMap((e) => [`./perf-worker.${e}`, `../perf-worker.${e}`]);
  if (/[\\/]sharded\.[cm]?js$/.test(here)) candidates.push("./worker.js");
  for (const c of candidates) {
    const url = new URL(c, here);
    if (fileExists(url)) return { url };
  }
  return null;
}

let liveWorkers = 0;
/** Worker threads spawned by the Performance Lab that have not exited yet (leak checks in tests). */
export function liveWorkerCount(): number {
  return liveWorkers;
}

interface Slot {
  index: number;
  worker: Worker;
  ready: boolean;
  done: boolean;
  exited: boolean;
  taken: number;
  accounted: number;
  lastTick?: TickPayload;
  lastSnapshot?: MetricsSnapshot;
  outcome?: OutcomeSnapshot;
  snapshot?: MetricsSnapshot;
  exit: Promise<void>;
}

/** Merges per-worker self-checks (§6 evaluated in every worker) into one report section. */
export function mergeHealth(list: readonly { health: GeneratorHealth; limitations: Limitation[] }[]): {
  health: GeneratorHealth;
  limitations: Limitation[];
} {
  const hs = list.map((x) => x.health);
  const max = (f: (h: GeneratorHealth) => number): number => (hs.length ? Math.max(...hs.map(f)) : 0);
  const sum = (f: (h: GeneratorHealth) => number): number => hs.reduce((a, h) => a + f(h), 0);
  const reasons: string[] = [];
  const remedies = new Set<string>();
  hs.forEach((h, i) => {
    for (const r of h.reasons) reasons.push(`worker ${i}: ${r}`);
    for (const r of h.remedies) remedies.add(r);
  });
  const saturated = hs.some((h) => h.saturated);
  const health: GeneratorHealth = {
    eventLoopDelayP99Ms: max((h) => h.eventLoopDelayP99Ms),
    eventLoopDelayMaxMs: max((h) => h.eventLoopDelayMaxMs),
    cpuPercent: max((h) => h.cpuPercent),
    schedulingLagP99Ms: max((h) => h.schedulingLagP99Ms),
    schedulingLagMaxMs: max((h) => h.schedulingLagMaxMs),
    dropped: sum((h) => h.dropped),
    meanInFlight: round(sum((h) => h.meanInFlight)),
    littlesLawExpected: round(sum((h) => h.littlesLawExpected)),
    littlesLawMismatch: max((h) => h.littlesLawMismatch),
    maxOpenSockets: sum((h) => h.maxOpenSockets),
    saturated,
    reasons,
    remedies: [...remedies],
    workers: hs.length,
    perWorker: hs,
  };
  if (hs.length > 0 && hs.every((h) => h.targetRate !== undefined))
    health.targetRate = round(sum((h) => h.targetRate ?? 0));
  if (hs.length > 0 && hs.every((h) => h.achievedRate !== undefined))
    health.achievedRate = round(sum((h) => h.achievedRate ?? 0));
  const limitations: Limitation[] = saturated
    ? [
        {
          code: "generator-saturated",
          message: `Load generator may be the bottleneck (self-check per worker): ${reasons.join("; ")}. Remedies: ${[...remedies].join("; ")}.`,
          impact: "reduces-confidence",
        },
      ]
    : [];
  return { health, limitations };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function errOf(e: unknown): RpcError {
  const code = (e as { code?: unknown })?.code;
  return {
    message: e instanceof Error ? e.message : String(e),
    ...(typeof code === "string" ? { code } : {}),
  };
}

export async function executeSharded(
  input: PerformanceInput,
  ctx: EngineContext,
  deps: PerformanceDeps,
  n: number,
  entry: WorkerEntry,
): Promise<EngineResult<PerformanceData>> {
  const pre = prepareRun(input, ctx);
  const { lease } = pre;
  const rootRng = runRootRng(input, ctx);
  const remaining = lease.remaining;
  const plans = planShards(input, n, {
    maxInFlight: pre.maxInFlight,
    connections: pre.connections,
    rpsCap: pre.throttleCap,
    requestBudget: Number.isFinite(remaining) ? Math.max(0, remaining) : Number.POSITIVE_INFINITY,
    runSeed: rootRng.seed,
  });
  if (pre.throttleCap !== null && (input.vus ?? 10) % n !== 0) {
    pre.limitations.push({
      code: "workers-rate-cap-split",
      message: `The rate cap (${pre.throttleCap} req/s) is enforced as ${round(pre.throttleCap / n)} req/s per worker; VUs split unevenly (${plans.map((p) => p.vus).join("/")}), so total throughput may stay below the cap.`,
      impact: "informational",
    });
  }

  const guard = ctx.safety as {
    lookup?: LookupFunction;
    recheckDns?(host: string): Promise<void>;
    checkRedirect?(from: URL | string, location: string): SafetyDecision;
  };
  const tickMs = deps.tickMs ?? 1000;
  const abortEntries = pre.thresholdEntries.filter((t) => t.abortOnFail);
  const abortedBy = new Set<string>();
  const totalVus = input.vus ?? 10;

  // ---- RPC answers (Safety Guard lives here)
  const answer = async (req: RpcRequest): Promise<unknown> => {
    if (req.op === "lookup") {
      const fn = guard.lookup;
      if (!fn) throw Object.assign(new Error("no Safety Guard lookup"), { code: "ENOTFOUND" });
      return new Promise((resolve, reject) => {
        (fn as unknown as (h: string, o: object, cb: (e: Error | null, a: unknown) => void) => void)(
          req.host,
          { all: true, family: req.family },
          (err, addrs) => (err ? reject(err) : resolve(addrs)),
        );
      });
    }
    if (req.op === "recheck") {
      await guard.recheckDns?.(req.host);
      return null;
    }
    return guard.checkRedirect ? guard.checkRedirect(req.from, req.location) : { allowed: true };
  };

  // ---- spawn
  const slots: Slot[] = [];
  const tickMerger = new TickWindowMerger(plans.length);
  let failure: RpcError | null = null;
  let globalStop: { reason: StopReason; safetyAbort?: SafetyAbortInfo } | null = null;
  let terminateTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveAllDone: () => void = () => undefined;
  const allDone = new Promise<void>((r) => {
    resolveAllDone = r;
  });
  const checkAllDone = (): void => {
    if (slots.every((s) => s.done || s.exited)) resolveAllDone();
  };
  const post = (s: Slot, m: MainToWorker): void => {
    if (!s.exited) s.worker.postMessage(m);
  };
  const terminateAll = (): void => {
    for (const s of slots) if (!s.exited) void s.worker.terminate();
  };
  const graceMs = deps.workerTerminateGraceMs ?? 2000;
  const broadcastStop = (reason: StopReason, hard: boolean, safetyAbort?: SafetyAbortInfo): void => {
    if (!globalStop) globalStop = { reason, ...(safetyAbort ? { safetyAbort } : {}) };
    for (const s of slots) post(s, { t: "stop", reason, hard, ...(safetyAbort ? { safetyAbort } : {}) });
    if (hard && terminateTimer === undefined) {
      // Cancellation / safety abort: workers abort in-flight work at once; stragglers are terminated.
      terminateTimer = setTimeout(() => {
        terminateAll();
      }, graceMs);
      terminateTimer.unref?.();
    }
  };
  const account = (s: Slot): void => {
    const delta = s.taken - s.accounted;
    if (delta <= 0) return;
    s.accounted = s.taken;
    if (!lease.take(delta) && !globalStop) broadcastStop("budget-exhausted", false);
  };

  for (const p of plans) {
    const shardInput: PerformanceInput = {
      ...input,
      workers: 1,
      ...(p.vus !== undefined ? { vus: p.vus } : {}),
      ...(p.iterations !== undefined ? { iterations: p.iterations } : {}),
    };
    const init: WorkerInit = {
      kind: WORKER_KIND,
      input: shardInput,
      shard: { count: p.count, index: p.index, totalVus },
      seed: p.seed,
      maxInFlight: p.maxInFlight,
      connections: p.connections,
      rpsCap: p.rpsCap,
      requestQuota: p.requestQuota,
      spinMs: defaultSpinMs(deps),
      tickMs,
      ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
      ...(deps.dnsRecheckIntervalMs !== undefined ? { dnsRecheckIntervalMs: deps.dnsRecheckIntervalMs } : {}),
      safety: {
        lookup: typeof guard.lookup === "function",
        recheckDns: typeof guard.recheckDns === "function",
        checkRedirect: typeof guard.checkRedirect === "function",
      },
      snapshotTicks: abortEntries.length > 0,
    };
    const worker = new Worker(entry.bootstrap ?? entry.url, {
      workerData: init,
      ...(entry.bootstrap ? { eval: true } : entry.execArgv ? { execArgv: entry.execArgv } : {}),
      name: `sw-perf-${p.index}`,
    });
    liveWorkers++;
    const slot: Slot = {
      index: p.index,
      worker,
      ready: false,
      done: false,
      exited: false,
      taken: 0,
      accounted: 0,
      exit: Promise.resolve(),
    };
    slot.exit = new Promise<void>((resolve) => {
      worker.once("exit", () => {
        liveWorkers--;
        slot.exited = true;
        checkAllDone();
        resolve();
      });
    });
    worker.on("error", (e) => {
      failure ??= errOf(e);
      broadcastStop("cancelled", true);
      terminateAll();
    });
    worker.on("message", (m: WorkerToMain) => {
      switch (m.t) {
        case "ready":
          slot.ready = true;
          if (slots.length === plans.length && slots.every((s) => s.ready)) startAll();
          break;
        case "rpc":
          answer(m.req).then(
            (value) => post(slot, { t: "rpc", id: m.id, ok: true, value }),
            (e: unknown) => post(slot, { t: "rpc", id: m.id, ok: false, error: errOf(e) }),
          );
          break;
        case "tick":
          slot.lastTick = m.payload;
          if (m.window) tickMerger.offer(slot.index, m.window.startMs, m.window.hist);
          slot.taken = m.taken;
          if (m.snapshot) slot.lastSnapshot = m.snapshot;
          account(slot);
          break;
        case "stop":
          // A worker-local stop (budget share / data partition exhausted, …) stops the whole run.
          if (!globalStop) broadcastStop(m.reason, false);
          break;
        case "done":
          slot.outcome = m.outcome;
          slot.snapshot = m.snapshot;
          slot.taken = m.taken;
          slot.done = true;
          account(slot);
          void slot.worker.terminate();
          checkAllDone();
          break;
        case "fail":
          failure ??= m.error;
          slot.done = true;
          broadcastStop("cancelled", true);
          terminateAll();
          checkAllDone();
          break;
      }
    });
    slots.push(slot);
  }

  // ---- start: one shared absolute instant so open-model phases interleave
  let t0Local = Number.POSITIVE_INFINITY;
  let started = false;
  function startAll(): void {
    if (started) return;
    started = true;
    const startAtEpochMs = performance.timeOrigin + performance.now() + 20;
    t0Local = startAtEpochMs - performance.timeOrigin;
    for (const s of slots) post(s, { t: "start", startAtEpochMs });
  }
  // A worker that loaded before the loop finished registering the others.
  if (slots.every((s) => s.ready)) startAll();

  // ---- global stop sources (same rules as in-process)
  const external = [ctx.signal, ctx.safety.killSwitch];
  const leaseSignal = (lease as { signal?: AbortSignal }).signal;
  const onCancel = (): void => {
    const reason: unknown = ctx.safety.killSwitch.aborted ? ctx.safety.killSwitch.reason : undefined;
    if (isRebind(reason)) {
      broadcastStop("safety-abort", true, { code: reason.code, message: reason.message });
      return;
    }
    broadcastStop("cancelled", true);
    if (!started) terminateAll();
  };
  const onLeaseAbort = (): void => {
    if (ctx.signal.aborted || ctx.safety.killSwitch.aborted) onCancel();
    else broadcastStop("budget-exhausted", false);
  };
  for (const s of external) {
    if (s.aborted) onCancel();
    else s.addEventListener("abort", onCancel, { once: true });
  }
  if (leaseSignal) leaseSignal.addEventListener("abort", onLeaseAbort, { once: true });

  // ---- live view + abortOnFail on merged snapshots
  const mergeRng = rootRng.fork("merge");
  const tick = setInterval(() => {
    const ticks = slots.map((s) => s.lastTick).filter((x): x is TickPayload => x !== undefined);
    if (ticks.length === 0) return;
    // Exact union percentiles: HDR-add the newest window every live worker closed (once per window).
    const merged = tickMerger.merge(slots.map((s) => !s.done));
    ctx.events.emit("perf.tick", {
      runId: pre.runId,
      elapsedS: Math.max(...ticks.map((t) => t.elapsedS)),
      phase: ticks[0]?.phase ?? "measure",
      rps: round(ticks.reduce((a, t) => a + t.rps, 0)),
      p95: merged ? Math.round(merged.p95) / 1000 : 0,
      p99: merged ? Math.round(merged.p99) / 1000 : 0,
      errors: ticks.reduce((a, t) => a + t.errors, 0),
      totalErrors: ticks.reduce((a, t) => a + t.totalErrors, 0),
      requests: ticks.reduce((a, t) => a + t.requests, 0),
      inFlight: ticks.reduce((a, t) => a + t.inFlight, 0),
      workers: slots.length,
    });
    if (abortEntries.length > 0 && !globalStop) {
      const snaps = slots.map((s) => s.lastSnapshot);
      const now = performance.now();
      const measureStart = t0Local + input.warmup;
      if (now >= measureStart && snaps.every((x) => x !== undefined)) {
        const live = mergeSnapshots(snaps as MetricsSnapshot[], {
          warmupMs: input.warmup,
          random: () => mergeRng.next(),
        });
        if (abortCheck(abortEntries, live.metrics, now - measureStart, abortedBy)) {
          broadcastStop("threshold-abort", false);
        }
      }
    }
  }, tickMs);
  tick.unref?.();

  try {
    await allDone;
  } finally {
    clearInterval(tick);
    if (terminateTimer !== undefined) clearTimeout(terminateTimer);
    for (const s of external) s.removeEventListener("abort", onCancel);
    if (leaseSignal) leaseSignal.removeEventListener("abort", onLeaseAbort);
    terminateAll();
    await Promise.all(slots.map((s) => s.exit));
    lease.release();
  }

  const fail = failure as RpcError | null;
  if (fail) {
    const e = new Error(`performance worker failed: ${fail.message}`);
    if (fail.code) Object.assign(e, { code: fail.code });
    throw e;
  }

  // ---- merge
  const reported = slots.filter((s) => s.outcome && s.snapshot);
  const lost = slots.length - reported.length;
  if (lost > 0) {
    pre.limitations.push({
      code: "workers-terminated",
      message: `${lost} of ${slots.length} workers were terminated before reporting; their requests are missing from the results.`,
      impact: "reduces-confidence",
    });
  }
  const merged = mergeSnapshots(
    reported.map((s) => s.snapshot as MetricsSnapshot),
    { warmupMs: input.warmup, random: () => mergeRng.next() },
  );
  const outs = reported.map((s) => s.outcome as OutcomeSnapshot);
  const gs = globalStop as { reason: StopReason; safetyAbort?: SafetyAbortInfo } | null;
  const stopReason: StopReason =
    gs?.reason ?? outs.find((o) => o.stopReason !== "completed")?.stopReason ?? "completed";
  const health = mergeHealth(outs.map((o) => o.health));
  const sumOpt = (f: (o: OutcomeSnapshot) => number | undefined): number | undefined =>
    outs.length > 0 && outs.every((o) => f(o) !== undefined)
      ? outs.reduce((a, o) => a + (f(o) ?? 0), 0)
      : undefined;
  const targetRate = sumOpt((o) => o.targetRate);
  const achievedRate = sumOpt((o) => o.achievedRate);
  const outcome: LoadOutcome = {
    metrics: merged.metrics,
    t0: 0,
    stopReason,
    measuredMs: outs.length > 0 ? Math.max(...outs.map((o) => o.measuredMs)) : 0,
    iterationsDone: outs.reduce((a, o) => a + o.iterationsDone, 0),
    throttledWaits: outs.reduce((a, o) => a + o.throttledWaits, 0),
    gracefulExpired: outs.some((o) => o.gracefulExpired),
    safetyAbort: gs?.safetyAbort ?? outs.find((o) => o.safetyAbort)?.safetyAbort ?? null,
    ...(targetRate !== undefined ? { targetRate } : {}),
    ...(achievedRate !== undefined ? { achievedRate } : {}),
    health,
  };
  return finalizePerformance({
    input,
    ctx,
    pre,
    outcome,
    series: seriesPoints(merged.windows, merged.windowMs),
    abortedBy,
    seed: rootRng.seed,
    workers: slots.length,
  });
}
