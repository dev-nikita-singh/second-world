/**
 * Message protocol between the main thread and Performance Lab worker_threads shards.
 * See docs/03-engines/performance-lab.md §7. Types only.
 *
 * Safety stays in the main thread: workers never resolve DNS themselves; every new connection's
 * lookup, every DNS re-check and every redirect hop is answered by the main thread's Safety Guard
 * over the worker's MessagePort ("rpc"). Secrets travel only inside `input` (never logged).
 */
import type { LoadOutcome, SafetyAbortInfo, StopReason, TickPayload } from "./engine.js";
import type { PerformanceInput } from "./schema.js";
import type { MetricsSnapshot } from "./shard.js";

export const WORKER_KIND = "sw-perf-worker";

export interface WorkerInit {
  kind: typeof WORKER_KIND;
  /** Shard input: `vus` / `iterations` are this worker's share, `rate` stays global, `workers` = 1. */
  input: PerformanceInput;
  shard: { count: number; index: number; totalVus: number };
  seed: number;
  maxInFlight: number;
  connections: number;
  /** Closed/iterations: this worker's GCRA rate (global cap / N). */
  rpsCap: number | null;
  /** This worker's share of the request budget (+∞ = unlimited). */
  requestQuota: number;
  spinMs: number;
  tickMs: number;
  cwd?: string;
  dnsRecheckIntervalMs?: number;
  /** Which Safety Guard hooks the main thread can answer. */
  safety: { lookup: boolean; recheckDns: boolean; checkRedirect: boolean };
  /** abortOnFail thresholds exist: send a metrics snapshot with every tick (merged in main). */
  snapshotTicks: boolean;
}

export type RpcRequest =
  | { op: "lookup"; host: string; family: number }
  | { op: "recheck"; host: string }
  | { op: "redirect"; from: string; location: string };

export interface RpcError {
  message: string;
  code?: string;
}

export type OutcomeSnapshot = Omit<LoadOutcome, "metrics" | "t0">;

export type WorkerToMain =
  | { t: "ready" }
  | { t: "rpc"; id: number; req: RpcRequest }
  | { t: "tick"; payload: TickPayload; taken: number; snapshot?: MetricsSnapshot }
  | { t: "stop"; reason: StopReason }
  | { t: "done"; outcome: OutcomeSnapshot; snapshot: MetricsSnapshot; taken: number }
  | { t: "fail"; error: RpcError };

export type MainToWorker =
  | { t: "start"; startAtEpochMs: number }
  | { t: "stop"; reason: StopReason; hard: boolean; safetyAbort?: SafetyAbortInfo }
  | { t: "rpc"; id: number; ok: true; value: unknown }
  | { t: "rpc"; id: number; ok: false; error: RpcError };
