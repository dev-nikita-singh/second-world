/**
 * PerformanceData: the payload of a Performance Lab EngineResult.
 * See docs/03-engines/performance-lab.md §4 (metrics), §6 (generator health), §9 (output).
 *
 * Units: latency summaries in milliseconds (3 decimals, from µs HDR histograms);
 * encoded histograms are base64 HDR in MICROSECONDS (decode with LatencyHistogram.decode).
 * "corrected" = coordinated-omission corrected (default for reports), "raw" = from actual send.
 */
import type { LatencySummaryMs } from "./metrics.js";
import type { GeneratorHealth } from "./self-check.js";
import type { ThresholdResult } from "./thresholds.js";

export type { GeneratorHealth, LatencySummaryMs, ThresholdResult };

export interface LatencyPairSummary {
  corrected: LatencySummaryMs;
  raw: LatencySummaryMs;
}

export interface EndpointSummary {
  /** "METHOD /path-template" — also the threshold scope `endpoint.<key>`. */
  key: string;
  method: string;
  path: string;
  scenario: string;
  requests: number;
  ok: number;
  failed: number;
  timeouts: number;
  rps: number;
  errorRate: number;
  bytesIn: number;
  bytesOut: number;
  latency: LatencyPairSummary;
  /** Time to first byte (headers received), ms. */
  ttfb: LatencySummaryMs;
  status: Record<string, number>;
  errors: Record<string, number>;
}

export interface ScenarioSummary {
  name: string;
  iterations: number;
  ok: number;
  failed: number;
  requests: number;
  /** Iteration duration (intended start → end of last step), ms. */
  duration: LatencySummaryMs;
}

export interface SeriesPoint {
  /** Seconds since run start (window start). */
  t: number;
  requests: number;
  ok: number;
  failed: number;
  rps: number;
  bytesIn: number;
  /** Corrected latency percentiles in this window (ms, 2 significant-digit histograms). */
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface ErrorSampleOut {
  tMs: number;
  endpoint: string;
  kind: string;
  status: number;
  message: string;
}

export interface EnvironmentFingerprint {
  os: string;
  arch: string;
  cpus: number;
  cpuModel: string;
  node: string;
  hostname?: string;
  targetHost: string;
  targetResolvedIp?: string;
}

/** `timing: "detailed"` only. Connection phases are per new connection; request phases per measured request. */
export interface PhaseBreakdown {
  connections: number;
  connectErrors: number;
  /** Absent for IP-literal targets (no DNS lookup happens). */
  dns: LatencySummaryMs;
  tcp: LatencySummaryMs;
  /** https only. */
  tls: LatencySummaryMs;
  /** Connector call → usable socket. */
  connect: LatencySummaryMs;
  /** Handed to undici → written to a socket (pool queue + connection setup). */
  wait: LatencySummaryMs;
  /** Written → response headers (server time + RTT). */
  server: LatencySummaryMs;
  /** Headers → body fully read. */
  transfer: LatencySummaryMs;
}

export interface PerformanceData {
  schema: 1;
  target: string;
  model: "closed" | "open" | "iterations";
  arrival?: "constant" | "poisson";
  config: {
    rate?: number;
    vus?: number;
    iterations?: number;
    durationMs: number;
    rampUpMs: number;
    warmupMs: number;
    gracefulStopMs: number;
    timeoutMs: number;
    connections: number;
    maxInFlight?: number;
    seed?: number;
    /** Generator threads that ran (1 = in-process; >1 = worker_threads shards, §7). */
    workers?: number;
    scenarios: { name: string; weight: number; steps: number }[];
  };
  window: {
    startedAt: string;
    endedAt: string;
    /** Measured window (excludes warm-up and graceful-stop drain), ms. */
    measuredMs: number;
    warmupMs: number;
    /** Why scheduling stopped. */
    /** "safety-abort": the Safety Guard stopped the run mid-way (e.g. DNS rebind, F6). */
    stopReason:
      | "completed"
      | "cancelled"
      | "threshold-abort"
      | "budget-exhausted"
      | "data-exhausted"
      | "safety-abort";
  };
  totals: {
    requests: number;
    ok: number;
    failed: number;
    timeouts: number;
    /** Interrupted by cancellation or graceful-stop expiry; excluded from latency and error rate. */
    interrupted: number;
    /** Open-model arrivals refused at the maxInFlight cap. */
    dropped: number;
    budgetRefused: number;
    /** Closed/iterations: requests that waited for the safety GCRA rate cap. */
    throttled?: number;
    iterations: number;
    bytesIn: number;
    bytesOut: number;
    rps: number;
    okRps: number;
    failedRps: number;
    errorRate: number;
    timeoutRate: number;
    targetRate?: number;
    achievedRate?: number;
  };
  latency: LatencyPairSummary;
  endpoints: EndpointSummary[];
  scenarios: ScenarioSummary[];
  status: Record<string, number>;
  errors: { kind: string; count: number }[];
  errorSamples: ErrorSampleOut[];
  firstErrors: ErrorSampleOut[];
  histograms: {
    unit: "us";
    global: { corrected: string; raw: string };
    endpoints: Record<string, { corrected: string; raw: string }>;
  };
  series: SeriesPoint[];
  warmup: { requests: number; latency: LatencyPairSummary };
  generator: GeneratorHealth;
  /** Present only with `timing: "detailed"`. */
  phases?: PhaseBreakdown;
  thresholds: ThresholdResult[];
  environment: EnvironmentFingerprint;
  methods: {
    latency: string;
    percentiles: string;
    throughput: string;
    errorRate: string;
    coCorrection: string;
  };
}
