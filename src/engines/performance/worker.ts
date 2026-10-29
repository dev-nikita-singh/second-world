/**
 * Performance Lab worker_threads entry (one shard). See docs/03-engines/performance-lab.md §7.
 *
 * Runs the exact same generator as the in-process path (`runLoad`: schedulers, executor, metrics,
 * self-check) on this worker's share of the load, then sends back an encoded metrics snapshot.
 * Safety hooks (DNS lookup, DNS re-check, redirect checks) are answered by the main thread's
 * Safety Guard; this thread never resolves a target name on its own.
 *
 * Built as its own tsdown entry (`perf-worker`); under vitest/tsx the .ts file is loaded with the
 * tsx loader (see sharded.ts `resolveWorkerEntry`).
 */
import type { LookupFunction } from "node:net";
import { performance } from "node:perf_hooks";
import { isMainThread, type MessagePort, parentPort, workerData } from "node:worker_threads";
import { createUndiciExecutor, type ExecutorSafety } from "../../adapters/http/undici-executor.js";
import { systemClock } from "../../core/clock.js";
import { createRng } from "../../core/rng.js";
import { Gcra } from "../../core/safety/gcra.js";
import type { SafetyDecision } from "../../core/types.js";
import { type LoadOutcome, runLoad, type SafetyAbortInfo, type StopFn, type StopReason } from "./engine.js";
import { PhaseStats } from "./metrics.js";
import { compilePlan, loadData } from "./prepare.js";
import { snapshotMetrics } from "./shard.js";
import {
  type MainToWorker,
  type RpcError,
  type RpcRequest,
  WORKER_KIND,
  type WorkerInit,
  type WorkerToMain,
} from "./worker-protocol.js";

function errOf(e: unknown): RpcError {
  const code = (e as { code?: unknown })?.code;
  return {
    message: e instanceof Error ? e.message : String(e),
    ...(typeof code === "string" ? { code } : {}),
  };
}

export async function runPerfWorker(port: MessagePort, init: WorkerInit): Promise<void> {
  const send = (m: WorkerToMain): void => port.postMessage(m);
  const clock = systemClock;
  const input = init.input;

  // ---- RPC to the main thread (Safety Guard)
  let rpcSeq = 0;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const call = (req: RpcRequest): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++rpcSeq;
      pending.set(id, { resolve, reject });
      send({ t: "rpc", id, req });
    });
  const asError = (e: RpcError): Error => Object.assign(new Error(e.message), e.code ? { code: e.code } : {});

  // ---- control from main
  let startResolve: (epoch: number) => void = () => undefined;
  const started = new Promise<number>((r) => {
    startResolve = r;
  });
  let stopFn: StopFn | null = null;
  let pendingStop: { reason: StopReason; hard: boolean; safetyAbort?: SafetyAbortInfo } | null = null;
  port.on("message", (m: MainToWorker) => {
    if (m.t === "start") startResolve(m.startAtEpochMs);
    else if (m.t === "stop") {
      const opts = { hard: m.hard, ...(m.safetyAbort ? { safetyAbort: m.safetyAbort } : {}) };
      if (stopFn) stopFn(m.reason, opts);
      else pendingStop ??= { reason: m.reason, ...opts };
    } else if (m.t === "rpc") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(asError(m.error));
    }
  });

  const lookup = ((hostname: string, options: unknown, callback: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void;
    const o = (typeof options === "object" && options !== null ? options : {}) as {
      all?: boolean;
      family?: number | string;
    };
    const family =
      o.family === "IPv4" ? 4 : o.family === "IPv6" ? 6 : typeof o.family === "number" ? o.family : 0;
    call({ op: "lookup", host: hostname, family }).then(
      (v) => {
        const list = v as { address: string; family: number }[];
        const first = list[0];
        if (o.all) cb(null, list);
        else if (first) cb(null, first.address, first.family);
        else cb(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), "");
      },
      (e: Error) => cb(e as NodeJS.ErrnoException, o.all ? [] : ""),
    );
  }) as unknown as LookupFunction;

  const safety: ExecutorSafety = {
    ...(init.safety.lookup ? { lookup } : {}),
    ...(init.safety.recheckDns
      ? { recheckDns: async (host: string) => void (await call({ op: "recheck", host })) }
      : {}),
    ...(init.safety.checkRedirect
      ? {
          checkRedirect: async (from: URL | string, location: string) =>
            (await call({ op: "redirect", from: String(from), location })) as SafetyDecision,
        }
      : {}),
  };

  const phaseStats = input.timing === "detailed" ? new PhaseStats() : null;
  const executor = createUndiciExecutor({
    connections: init.connections,
    keepAlive: input.http.keepAlive,
    pipelining: input.http.pipelining,
    timeoutMs: input.timeout,
    connectTimeoutMs: input.connectTimeout,
    allowH2: input.http.version === "2",
    now: () => clock.now(),
    timing: input.timing,
    safety,
    ...(init.dnsRecheckIntervalMs !== undefined ? { dnsRecheckIntervalMs: init.dnsRecheckIntervalMs } : {}),
    ...(input.timing === "detailed" ? { onConnection: (t) => phaseStats?.recordConnection(t) } : {}),
  });

  try {
    const plan = compilePlan(input);
    const feeder = input.data
      ? await loadData(input.data, init.cwd, { count: init.shard.count, index: init.shard.index })
      : null;
    const gcra =
      init.rpsCap !== null && init.rpsCap > 0
        ? new Gcra({ rate: init.rpsCap, burst: Math.max(1, Math.ceil(init.rpsCap / 10)) })
        : null;
    let taken = 0;
    send({ t: "ready" });
    const startAt = await started;
    // Shared absolute start: epoch ms → this thread's monotonic clock.
    const t0 = startAt - performance.timeOrigin;
    const outcome: LoadOutcome = await runLoad({
      input,
      plan,
      feeder,
      clock,
      rootRng: createRng(init.seed),
      executor,
      phaseStats,
      maxInFlight: init.maxInFlight,
      connections: init.connections,
      spinMs: init.spinMs,
      tickMs: init.tickMs,
      t0,
      shard: init.shard,
      take: () => {
        if (taken >= init.requestQuota) return false;
        taken++;
        return true;
      },
      throttle: gcra ? (signal) => gcra.take(clock, 1, signal) : null,
      bindStop: (stop) => {
        stopFn = stop;
        if (pendingStop) {
          const p = pendingStop;
          stop(p.reason, { hard: p.hard, ...(p.safetyAbort ? { safetyAbort: p.safetyAbort } : {}) });
        }
        return () => {
          stopFn = null;
        };
      },
      onStop: (reason) => send({ t: "stop", reason }),
      onTick: (t) => {
        send({
          t: "tick",
          payload: t.payload,
          taken,
          ...(init.snapshotTicks && t.now >= t.measureStart
            ? { snapshot: snapshotMetrics(t.metrics, { windows: false }) }
            : {}),
        });
      },
    });
    await executor.close();
    const { metrics, t0: _t0, ...rest } = outcome;
    send({ t: "done", outcome: rest, snapshot: snapshotMetrics(metrics), taken });
  } catch (e) {
    await executor.close().catch(() => undefined);
    send({ t: "fail", error: errOf(e) });
  }
}

const data = workerData as WorkerInit | undefined;
if (!isMainThread && parentPort && data?.kind === WORKER_KIND) {
  void runPerfWorker(parentPort, data);
}
