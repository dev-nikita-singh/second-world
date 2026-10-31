/**
 * Cross-module contracts. Implementations live in core/* (owned by sw-core);
 * engines depend only on these interfaces. See docs/02-architecture.md §4.
 * Changing a signature here requires notifying every agent (see .agents/CONTRACTS.md).
 */
import type { z } from "zod";
import type { EngineId, EngineResult, Finding, Limitation } from "./evidence/schemas.js";

/** Monotonic clock. `now()` returns milliseconds with sub-ms precision. */
export interface Clock {
  now(): number;
  /** Wall-clock ISO-8601 UTC timestamp, for reports only. */
  isoNow(): string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Seeded deterministic PRNG (xoshiro128**). */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Exponential variate with the given mean (for Poisson arrivals / think time). */
  exponential(mean: number): number;
  pick<T>(items: readonly T[]): T;
  /** Independent child stream derived from this seed and a name. */
  fork(streamName: string): Rng;
  readonly seed: number;
}

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Event names are namespaced, e.g. "perf.tick", "finding.created". */
export interface EventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, listener: (payload: unknown) => void): () => void;
  once(event: string, listener: (payload: unknown) => void): () => void;
}

export type SafetyDecision =
  | { allowed: true }
  | { allowed: false; code: string; reason: string; hint?: string };

export interface BudgetRequest {
  maxRps?: number;
  maxConcurrency?: number;
  maxRequests?: number;
  maxDurationMs?: number;
}

/** Lease returned by SafetyGuard.reserve; engines call `take()` before each outbound request. */
export interface BudgetLease {
  /** Returns false when the request budget is exhausted (engine must stop). */
  take(n?: number): boolean;
  readonly remaining: number;
  release(): void;
}

export type DisruptiveAction =
  | "fault-injection"
  | "mutating-requests"
  | "evolution-execution"
  | "high-load"
  | "production-target";

export interface SafetyGuard {
  checkTarget(url: URL): SafetyDecision;
  /** Throws SafetyError if the request exceeds configured ceilings. */
  reserve(req: BudgetRequest): BudgetLease;
  requireApproval(action: DisruptiveAction, detail: string): Promise<void>;
  audit(event: { action: string; target?: string; detail?: Record<string, unknown> }): void;
  readonly killSwitch: AbortSignal;
}

export type CapabilityId =
  | "network.target"
  | "fs.read"
  | "git"
  | "docker"
  | "worker_threads"
  | "sqlite"
  | "telemetry.otlp"
  | "tty";

export interface CapabilityStatus {
  available: boolean;
  reason?: string;
  fix?: string;
}

export interface EnvironmentReport {
  os: { platform: NodeJS.Platform; release: string; arch: string; libc?: "glibc" | "musl"; wsl?: boolean };
  runtime: {
    name: "node" | "bun" | "deno";
    version: string;
    features: { workerThreads: boolean; sqlite: boolean; compileCache: boolean };
  };
  resources: { cpus: number; cpuQuota?: number; memTotal: number; memLimit?: number; fdLimit?: number };
  container: { inside: boolean; runtime?: string };
  ci: { inside: boolean; provider?: string };
  terminal: { tty: boolean; color: boolean; unicode: boolean; width: number };
  network: { proxy?: string; noProxy?: string[]; extraCA: boolean };
  tools: Partial<Record<"git" | "docker" | "toxiproxy" | "k6", string>>;
  capabilities: Partial<Record<CapabilityId, CapabilityStatus>>;
}

export interface EvidenceStore {
  addFinding(f: Finding): Finding;
  addLimitation(engine: EngineId, l: Limitation): void;
  findings(filter?: { engine?: EngineId }): Finding[];
  results(): EngineResult[];
  addResult(r: EngineResult): void;
}

export interface EngineContext {
  signal: AbortSignal;
  clock: Clock;
  rng: Rng;
  log: Logger;
  events: EventBus;
  evidence: EvidenceStore;
  safety: SafetyGuard;
  env: EnvironmentReport;
  /** Fully resolved config (shape defined by core/config). */
  config: Record<string, unknown>;
  /** Creates a ULID. */
  newId(): string;
}

export interface CapabilityRequirement {
  cap: CapabilityId;
  optional?: boolean;
}

export interface Engine<I, D = unknown> {
  readonly id: EngineId;
  readonly version: string;
  readonly inputSchema: z.ZodType<I>;
  readonly requires: readonly CapabilityRequirement[];
  run(input: I, ctx: EngineContext): Promise<EngineResult<D>>;
}
