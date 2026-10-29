/**
 * Performance Lab metrics: global + per-endpoint + per-scenario HDR histograms (µs),
 * raw AND coordinated-omission-corrected latency, status/error counts, bytes,
 * 1-second windows and a reservoir of error samples.
 * See docs/03-engines/performance-lab.md §4 and docs/04-data-structures-and-algorithms.md §3.5, §4.
 */
import { LatencyHistogram, type LatencySummary } from "../../shared/stats/hdr.js";
import { Reservoir } from "../../shared/stats/reservoir.js";
import { WindowedSeries } from "../../shared/stats/window.js";

export interface RequestSample {
  endpoint: string;
  scenario: string;
  method: string;
  /** Endpoint path template (unrendered). */
  path: string;
  /** Clock ms the request was handed to the transport. */
  startMs: number;
  /** Clock ms the request was *supposed* to start (open model). Equal to startMs otherwise. */
  intendedMs: number;
  headersMs: number;
  endMs: number;
  /** Closed model: expected interval (ms) for HdrHistogram-style CO correction. */
  expectedIntervalMs?: number | undefined;
  status: number;
  ok: boolean;
  /** Failure kind: transport kind, "status", "assertion" or "extract". */
  errorKind?: string | undefined;
  message?: string | undefined;
  bytesIn: number;
  bytesOut: number;
  /** Detailed timing only. */
  phases?: { waitMs: number; serverMs: number; transferMs: number } | undefined;
}

/** Detailed timing (`timing: "detailed"`): per-phase HDR histograms, µs. */
export class PhaseStats {
  /** Per new connection (warm-up included: connections are mostly opened then). */
  readonly dns = new LatencyHistogram({ digits: 3 });
  readonly tcp = new LatencyHistogram({ digits: 3 });
  readonly tls = new LatencyHistogram({ digits: 3 });
  readonly connect = new LatencyHistogram({ digits: 3 });
  connections = 0;
  connectErrors = 0;
  /** Per measured request. */
  readonly wait = new LatencyHistogram({ digits: 3 });
  readonly server = new LatencyHistogram({ digits: 3 });
  readonly transfer = new LatencyHistogram({ digits: 3 });

  recordConnection(t: {
    dnsMs?: number;
    tcpMs?: number;
    tlsMs?: number;
    totalMs: number;
    error?: string;
  }): void {
    if (t.error !== undefined) {
      this.connectErrors++;
      return;
    }
    this.connections++;
    this.connect.record(usOf(t.totalMs));
    if (t.dnsMs !== undefined) this.dns.record(usOf(t.dnsMs));
    if (t.tcpMs !== undefined) this.tcp.record(usOf(t.tcpMs));
    if (t.tlsMs !== undefined) this.tls.record(usOf(t.tlsMs));
  }
}

export interface ErrorSample {
  tMs: number;
  endpoint: string;
  kind: string;
  status: number;
  message: string;
}

export interface LatencySummaryMs {
  count: number;
  min: number;
  mean: number;
  stdDev: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  p999: number;
  max: number;
}

export function toMs(s: LatencySummary): LatencySummaryMs {
  const r = (us: number): number => Math.round(us) / 1000;
  return {
    count: s.count,
    min: r(s.min),
    mean: r(s.mean),
    stdDev: r(s.stdDev),
    p50: r(s.p50),
    p75: r(s.p75),
    p90: r(s.p90),
    p95: r(s.p95),
    p99: r(s.p99),
    p999: r(s.p999),
    max: r(s.max),
  };
}

const HIST = { digits: 3 } as const;
const MAX_LATENCY_US = 3_600_000_000;

export class LatencyPair {
  readonly raw = new LatencyHistogram(HIST);
  readonly corrected = new LatencyHistogram(HIST);
}

export class EndpointStats {
  readonly latency = new LatencyPair();
  readonly ttfb = new LatencyHistogram({ digits: 2 });
  requests = 0;
  ok = 0;
  failed = 0;
  timeouts = 0;
  bytesIn = 0;
  bytesOut = 0;
  readonly status = new Map<number, number>();
  readonly errors = new Map<string, number>();
  constructor(
    readonly key: string,
    readonly method: string,
    readonly path: string,
    readonly scenario: string,
  ) {}
}

export class ScenarioStats {
  /** Iteration duration (intended start → last step end), µs. */
  readonly latency = new LatencyPair();
  iterations = 0;
  ok = 0;
  failed = 0;
  requests = 0;
  timeouts = 0;
  constructor(readonly name: string) {}
}

function usOf(ms: number): number {
  const us = Math.round(ms * 1000);
  return Math.min(MAX_LATENCY_US, Math.max(0, us));
}

function inc<K>(m: Map<K, number>, k: K, n = 1): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

export interface MetricsOptions {
  /** Clock ms of the run start (t0). */
  startMs: number;
  /** Clock ms when warm-up ends; samples that *started* before it go to the warm-up bucket. */
  warmupEndMs: number;
  /** RNG for the error reservoir. */
  random: () => number;
  /** Reservoir size (default 50). */
  errorSamples?: number;
}

export class PerfMetrics {
  readonly global = new LatencyPair();
  readonly warmup = new LatencyPair();
  readonly endpoints = new Map<string, EndpointStats>();
  readonly scenarios = new Map<string, ScenarioStats>();
  readonly status = new Map<number, number>();
  readonly errors = new Map<string, number>();
  readonly series = new WindowedSeries({ windowMs: 1000, maxWindows: 3600 });
  readonly errorReservoir: Reservoir<ErrorSample>;
  /** First occurrence of each distinct (endpoint, kind, status), so rare errors are not lost. */
  readonly firstErrors = new Map<string, ErrorSample>();
  requests = 0;
  ok = 0;
  failed = 0;
  timeouts = 0;
  bytesIn = 0;
  bytesOut = 0;
  warmupRequests = 0;
  /** Requests interrupted by cancellation / graceful-stop expiry (not counted as errors). */
  interrupted = 0;
  /** Open-model arrivals that exceeded maxInFlight. */
  dropped = 0;
  /** Requests refused because the safety budget was exhausted. */
  budgetRefused = 0;
  /** Present only with detailed timing. */
  phases: PhaseStats | null = null;
  /** Clock ms of the last completed (measured) request. */
  lastEndMs = 0;
  readonly startMs: number;
  readonly warmupEndMs: number;

  constructor(opts: MetricsOptions) {
    this.startMs = opts.startMs;
    this.warmupEndMs = opts.warmupEndMs;
    this.errorReservoir = new Reservoir<ErrorSample>(opts.errorSamples ?? 50, opts.random);
  }

  endpoint(key: string, method: string, path: string, scenario: string): EndpointStats {
    let e = this.endpoints.get(key);
    if (!e) {
      e = new EndpointStats(key, method, path, scenario);
      this.endpoints.set(key, e);
    }
    return e;
  }

  scenario(name: string): ScenarioStats {
    let s = this.scenarios.get(name);
    if (!s) {
      s = new ScenarioStats(name);
      this.scenarios.set(name, s);
    }
    return s;
  }

  isWarmup(startMs: number): boolean {
    return startMs < this.warmupEndMs;
  }

  /** Records one completed request. Interrupted requests must use `recordInterrupted`. */
  record(s: RequestSample): void {
    const rawUs = usOf(s.endMs - s.startMs);
    const intendedUs = usOf(s.endMs - s.intendedMs);
    if (this.isWarmup(s.intendedMs)) {
      this.warmupRequests++;
      this.warmup.raw.record(rawUs);
      this.warmup.corrected.record(intendedUs);
      return;
    }
    const ep = this.endpoint(s.endpoint, s.method, s.path, s.scenario);
    const sc = this.scenario(s.scenario);
    const exp =
      s.expectedIntervalMs !== undefined && s.expectedIntervalMs > 0 ? usOf(s.expectedIntervalMs) : 0;
    for (const pair of [this.global, ep.latency]) {
      pair.raw.record(rawUs);
      if (exp > 0) pair.corrected.recordCorrected(intendedUs, exp);
      else pair.corrected.record(intendedUs);
    }
    ep.ttfb.record(usOf(s.headersMs - s.startMs));
    if (this.phases && s.phases) {
      this.phases.wait.record(usOf(s.phases.waitMs));
      this.phases.server.record(usOf(s.phases.serverMs));
      this.phases.transfer.record(usOf(s.phases.transferMs));
    }
    this.requests++;
    ep.requests++;
    sc.requests++;
    this.bytesIn += s.bytesIn;
    this.bytesOut += s.bytesOut;
    ep.bytesIn += s.bytesIn;
    ep.bytesOut += s.bytesOut;
    if (s.status > 0) {
      inc(this.status, s.status);
      inc(ep.status, s.status);
    }
    const isTimeout = s.errorKind === "timeout" || s.errorKind === "connect-timeout";
    if (s.ok) {
      this.ok++;
      ep.ok++;
    } else {
      this.failed++;
      ep.failed++;
      const kind = s.errorKind ?? "other";
      inc(this.errors, kind);
      inc(ep.errors, kind);
      if (isTimeout) {
        this.timeouts++;
        ep.timeouts++;
        sc.timeouts++;
      }
      const sample: ErrorSample = {
        tMs: Math.round(s.endMs - this.startMs),
        endpoint: s.endpoint,
        kind,
        status: s.status,
        message: (s.message ?? "").slice(0, 200),
      };
      this.errorReservoir.offer(sample);
      const fk = `${s.endpoint}|${kind}|${s.status}`;
      if (this.firstErrors.size < 50 && !this.firstErrors.has(fk)) this.firstErrors.set(fk, sample);
    }
    this.series.record(s.endMs - this.startMs, intendedUs, s.ok, s.bytesIn);
    if (s.endMs > this.lastEndMs) this.lastEndMs = s.endMs;
  }

  /** Records one scenario iteration (only when it started in the measured window). */
  recordIteration(scenario: string, intendedMs: number, endMs: number, ok: boolean): void {
    if (this.isWarmup(intendedMs)) return;
    const sc = this.scenario(scenario);
    sc.iterations++;
    if (ok) sc.ok++;
    else sc.failed++;
    const us = usOf(endMs - intendedMs);
    sc.latency.raw.record(us);
    sc.latency.corrected.record(us);
  }

  recordInterrupted(): void {
    this.interrupted++;
  }
}
