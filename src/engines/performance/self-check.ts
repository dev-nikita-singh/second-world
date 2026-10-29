/**
 * Generator self-check: is the load generator itself the bottleneck?
 * See docs/03-engines/performance-lab.md §6 and docs/04-data-structures-and-algorithms.md §4.6 (Little's Law).
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

import type { Limitation } from "../../core/evidence/schemas.js";

export interface GeneratorHealth {
  eventLoopDelayP99Ms: number;
  eventLoopDelayMaxMs: number;
  /** Generator CPU as % of one core over the run, excluding scheduler busy-wait. */
  cpuPercent: number;
  /** Scheduling lag (open model), ms. */
  schedulingLagP99Ms: number;
  schedulingLagMaxMs: number;
  /** Open model: arrivals per second the curve asked for in the measured window. */
  targetRate?: number;
  /** Open model: arrivals per second actually started in the measured window. */
  achievedRate?: number;
  dropped: number;
  /** Time-weighted mean in-flight requests over the measured window (L, exact integration). */
  meanInFlight: number;
  /** λ·W from measured throughput and mean raw latency. */
  littlesLawExpected: number;
  /** |L − λW| / max(L, λW); 0 when not applicable. */
  littlesLawMismatch: number;
  maxOpenSockets: number;
  saturated: boolean;
  reasons: string[];
  remedies: string[];
  /** worker_threads sharding (§7): number of generator threads; the self-check ran in each one. */
  workers?: number;
  /** Per-worker self-check (sharded runs only), indexed by worker. */
  perWorker?: GeneratorHealth[];
}

/**
 * Exact time-weighted average of the in-flight count over a window (Little's Law "L").
 * The step function n(t) is integrated at every start/end event: O(1) per event, no sampling,
 * so constant arrivals cannot alias with a sampling period.
 */
export class InFlightIntegrator {
  private n = 0;
  private last: number;
  private area = 0;
  private peak = 0;

  constructor(
    private winStart: number,
    private winEnd: number,
  ) {
    this.last = winStart;
  }

  /** Moves the window end (e.g. the run stopped early). Only affects segments not yet integrated. */
  setWindowEnd(t: number): void {
    this.winEnd = Math.max(this.winStart, Math.min(this.winEnd, t));
  }

  private advance(t: number): void {
    const a = Math.max(this.last, this.winStart);
    const b = Math.min(t, this.winEnd);
    if (b > a) this.area += this.n * (b - a);
    if (t > this.last) this.last = t;
  }

  /** A request started at `t` (clock ms). */
  start(t: number): void {
    this.advance(t);
    this.n++;
    if (this.n > this.peak) this.peak = this.n;
  }

  /** A request ended at `t` (clock ms). */
  end(t: number): void {
    this.advance(t);
    if (this.n > 0) this.n--;
  }

  get current(): number {
    return this.n;
  }

  get max(): number {
    return this.peak;
  }

  /** Mean in-flight over [winStart, min(winEnd, now)]. */
  mean(now: number): number {
    this.advance(now);
    const span = Math.min(now, this.winEnd) - this.winStart;
    return span > 0 ? this.area / span : 0;
  }
}

/**
 * CPU of the generator. In a worker_threads shard, process.cpuUsage() would count the whole process
 * (every shard), so a worker measures its own thread (process.threadCpuUsage, Node ≥ 22.19 / 23.9).
 */
const cpuUsage: (prev?: NodeJS.CpuUsage) => NodeJS.CpuUsage =
  !isMainThread && typeof (process as { threadCpuUsage?: unknown }).threadCpuUsage === "function"
    ? (prev) =>
        (process as unknown as { threadCpuUsage(p?: NodeJS.CpuUsage): NodeJS.CpuUsage }).threadCpuUsage(prev)
    : (prev) => process.cpuUsage(prev);

export class GeneratorMonitor {
  private readonly eld: IntervalHistogram;
  private cpu0 = cpuUsage();
  private wall0 = 0;
  private maxSockets = 0;

  constructor(private readonly now: () => number) {
    this.eld = monitorEventLoopDelay({ resolution: 10 });
  }

  start(): void {
    this.cpu0 = cpuUsage();
    this.wall0 = this.now();
    this.eld.enable();
  }

  sampleSockets(openSockets: number): void {
    if (openSockets > this.maxSockets) this.maxSockets = openSockets;
  }

  stop(): { eldP99Ms: number; eldMaxMs: number; cpuMs: number; wallMs: number } {
    this.eld.disable();
    const cpu = cpuUsage(this.cpu0);
    const n = this.eld.count;
    return {
      eldP99Ms: n > 0 ? this.eld.percentile(99) / 1e6 : 0,
      eldMaxMs: n > 0 ? this.eld.max / 1e6 : 0,
      cpuMs: (cpu.user + cpu.system) / 1000,
      wallMs: Math.max(1, this.now() - this.wall0),
    };
  }

  get maxOpenSockets(): number {
    return this.maxSockets;
  }
}

/** Minimum evidence before the Little's Law rule may fire. */
export const LITTLES_LAW_MIN_REQUESTS = 100;
export const LITTLES_LAW_MIN_WINDOW_MS = 1000;
/** Below this many arrivals p99 is effectively the max, so one cold-start outlier would trip the lag rule. */
export const LAG_RULE_MIN_SAMPLES = 200;

export interface SelfCheckInput {
  model: "open" | "closed" | "iterations";
  eldP99Ms: number;
  eldMaxMs: number;
  cpuMs: number;
  spinMs: number;
  wallMs: number;
  lagP99Ms: number;
  lagMaxMs: number;
  /** Number of scheduling-lag samples (open model arrivals). Omitted = treated as enough. */
  lagSamples?: number;
  /** Open model: target inter-arrival interval (ms). */
  intervalMs?: number;
  targetRate?: number;
  achievedRate?: number;
  dropped: number;
  /** Time-weighted mean in-flight over the measured window (exact). */
  meanInFlight: number;
  /** Completed requests in the measured window. */
  completed: number;
  /** Measured window length, ms. */
  measuredMs: number;
  throughput: number;
  meanLatencyMs: number;
  /** Latency stayed flat (p99 of the measured run within 2x p50) — server not the cause. */
  latencyFlat: boolean;
  maxOpenSockets: number;
  connections: number;
}

/** Pure evaluation of the §6 rules. */
export function evaluateGeneratorHealth(i: SelfCheckInput): {
  health: GeneratorHealth;
  limitations: Limitation[];
} {
  const reasons: string[] = [];
  const remedies = new Set<string>();
  const busyCpuMs = Math.max(0, i.cpuMs - i.spinMs);
  const cpuPercent = (busyCpuMs / i.wallMs) * 100;
  if (i.eldP99Ms > 50) {
    reasons.push(`event-loop delay p99 ${i.eldP99Ms.toFixed(1)} ms > 50 ms`);
    remedies.add('enable `workers: "auto"` or run the generator on a separate machine');
  }
  if (cpuPercent > 85) {
    reasons.push(`generator CPU ${cpuPercent.toFixed(0)}% > 85% of one core`);
    remedies.add('enable `workers: "auto"` or run the generator on a separate machine');
  }
  if (
    i.model === "open" &&
    i.intervalMs !== undefined &&
    (i.lagSamples ?? Infinity) >= LAG_RULE_MIN_SAMPLES
  ) {
    // Timer granularity (≈1 ms, up to 15.6 ms on Windows) is not saturation: allow 2 ms of jitter.
    const limit = Math.max(0.1 * i.intervalMs, 2);
    if (i.lagP99Ms > limit) {
      reasons.push(
        `scheduling lag p99 ${i.lagP99Ms.toFixed(2)} ms > ${limit.toFixed(2)} ms (10% of the inter-arrival interval)`,
      );
      remedies.add('enable `workers: "auto"`');
    }
  }
  if (i.targetRate !== undefined && i.achievedRate !== undefined && i.targetRate > 0) {
    if (i.achievedRate < 0.95 * i.targetRate && i.latencyFlat) {
      reasons.push(
        `achieved rate ${i.achievedRate.toFixed(1)}/s < 95% of target ${i.targetRate.toFixed(1)}/s while latency is flat`,
      );
      remedies.add("raise `http.connections` or `maxInFlight`");
    }
  }
  if (i.dropped > 0) {
    reasons.push(`${i.dropped} arrivals dropped at the maxInFlight cap`);
    remedies.add("raise `maxInFlight` / `http.connections` (or the target is too slow for this rate)");
  }
  const expected = i.throughput * (i.meanLatencyMs / 1000);
  let mismatch = 0;
  // Needs enough evidence: short or tiny windows are dominated by edge effects.
  if (
    i.completed >= LITTLES_LAW_MIN_REQUESTS &&
    i.measuredMs >= LITTLES_LAW_MIN_WINDOW_MS &&
    expected >= 0.5
  ) {
    mismatch = Math.abs(i.meanInFlight - expected) / Math.max(i.meanInFlight, expected);
    if (mismatch > 0.2) {
      reasons.push(
        `Little's Law mismatch ${(mismatch * 100).toFixed(0)}%: measured concurrency ${i.meanInFlight.toFixed(2)} vs λ·W ${expected.toFixed(2)}`,
      );
      remedies.add("raise `http.connections` (possible connection-pool starvation)");
    }
  }
  const saturated = reasons.length > 0;
  const health: GeneratorHealth = {
    eventLoopDelayP99Ms: round(i.eldP99Ms),
    eventLoopDelayMaxMs: round(i.eldMaxMs),
    cpuPercent: round(cpuPercent),
    schedulingLagP99Ms: round(i.lagP99Ms),
    schedulingLagMaxMs: round(i.lagMaxMs),
    dropped: i.dropped,
    meanInFlight: round(i.meanInFlight),
    littlesLawExpected: round(expected),
    littlesLawMismatch: round(mismatch),
    maxOpenSockets: i.maxOpenSockets,
    saturated,
    reasons,
    remedies: [...remedies],
  };
  if (i.targetRate !== undefined) health.targetRate = round(i.targetRate);
  if (i.achievedRate !== undefined) health.achievedRate = round(i.achievedRate);
  const limitations: Limitation[] = saturated
    ? [
        {
          code: "generator-saturated",
          message: `Load generator may be the bottleneck: ${reasons.join("; ")}. Remedies: ${[...remedies].join("; ")}.`,
          impact: "reduces-confidence",
        },
      ]
    : [];
  return { health, limitations };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
