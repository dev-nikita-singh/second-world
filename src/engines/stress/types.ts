/**
 * StressData: payload of a Stress & Capacity Lab EngineResult.
 * See docs/03-engines/stress-capacity-lab.md §4 (output) and §6 (honesty rules).
 * Latency in ms (CO-corrected, from the Performance Lab), throughput in requests/s.
 */
import type { EnvironmentFingerprint } from "../performance/types.js";
import type { StageKind } from "./planner.js";
import type { StressMode } from "./schema.js";

export type StageStatus = "passed" | "breached" | "error" | "cancelled";

export interface StageThreshold {
  expression: string;
  metric: string;
  /** Normalised units (ms, 0..1, per s). null when no data. */
  actual: number | null;
  threshold: number;
  passed: boolean;
}

export interface StageSeriesPoint {
  /** Seconds since the stage's measured window started. */
  t: number;
  requests: number;
  failed: number;
  rps: number;
  p95: number;
  p99: number;
}

export interface StageResult {
  index: number;
  kind: StageKind;
  label: string;
  /** VUs or requests/s (see StressData.loadType). */
  level: number;
  holdMs: number;
  settleMs: number;
  status: StageStatus;
  /** The stage's perf run could not reach the target at all (perf limitation `target-unreachable`). */
  targetUnreachable?: boolean;
  /** Why the stage counts as breached (threshold expressions, "error-rate", "consecutive-windows: …"). */
  breachReasons: string[];
  perfRunId: string;
  perfStatus: string;
  startedAt: string;
  endedAt: string;
  /** Monotonic clock ms at stage start / end (for recovery timing). */
  startMs: number;
  endMs: number;
  /** Measured window, ms. */
  measuredMs: number;
  requests: number;
  ok: number;
  failed: number;
  errorRate: number;
  /** Achieved throughput, requests/s. */
  throughput: number;
  targetRate?: number;
  achievedRate?: number;
  /** Mean in-flight requests (concurrency N for USL in rate mode). */
  meanInFlight: number;
  latency: { mean: number; p50: number; p90: number; p95: number; p99: number; max: number };
  thresholds: StageThreshold[];
  generator: {
    /** Saturated for stress purposes (any self-check reason other than a Little's Law mismatch). */
    saturated: boolean;
    /** Perf self-check flagged only a Little's Law mismatch (reduces confidence, does not invalidate). */
    littlesLawOnly?: boolean;
    reasons: string[];
    cpuPercent: number;
    eventLoopDelayP99Ms: number;
  };
  /** True when this stage is at or after the first generator-saturated stage (conclusions invalid). */
  invalid: boolean;
  /**
   * The safety rate cap (min(safety.maxRps, budget.maxRps)) throttled requests in this stage
   * (perf limitation PERF-THROTTLED-BY-SAFETY / totals.throttled > 0) and the stage ran near the cap
   * (runner.ts CAP_NEAR_FRACTION): throughput reflects the cap, not the target's capacity. Optional: absent in reports stored before this field existed (= false).
   */
  capped?: boolean;
  /** Requests that waited for the safety rate cap (absent = 0). */
  throttled?: number;
  /** The cap in req/s when known. */
  capRps?: number;
  /**
   * The safety GCRA delayed some requests (bursts above its burst tolerance) but the stage's rate
   * stayed below CAP_NEAR_FRACTION of the cap: not capped, reported as informational.
   */
  burstSmoothed?: boolean;
  /** Aborted early because window-level thresholds failed k consecutive windows. */
  abortedEarly: boolean;
  series: StageSeriesPoint[];
  /** Encoded corrected HDR histogram (µs, base64). */
  histogram?: string;
}

export type StressStopReason =
  | "completed"
  | "breach"
  | "error-rate"
  | "saturation"
  | "budget"
  | "max-stages"
  | "safety"
  /** Breakpoint mode: a stage hit the safety rate cap; higher load cannot be tested. */
  | "safety-cap"
  | "error"
  | "cancelled";

export interface UslEstimate {
  kind: "estimate";
  /** null when refused. */
  lambda: number | null;
  sigma: number | null;
  kappa: number | null;
  r2: number | null;
  /** Projected peak concurrency √((1−σ)/κ); null when κ = 0 or refused. */
  peakN: number | null;
  /** Projected peak throughput X(N*). */
  peakThroughput: number | null;
  /** N values used ("vus" level or mean in-flight in rate mode). */
  basis: "vus" | "mean-in-flight";
  points: number;
  refused?: string;
  /** True when N* lies beyond the tested range. */
  extrapolated?: boolean;
}

export interface StressData {
  schema: 1;
  mode: StressMode;
  loadType: "vus" | "rate";
  target: string;
  stopReason: StressStopReason;
  stopDetail?: string;
  stages: StageResult[];
  /** Index of the first generator-saturated stage; stages from here on are invalid. */
  invalidFromStage: number | null;
  capacity: {
    /** Highest tested load that met all requirements in this environment (never "max capacity"). */
    testedCapacity: number | null;
    stageIndex: number | null;
    statement: string;
    /** True when the stage behind the statement was throttled by the safety rate cap. */
    limitedBySafetyCap?: boolean;
  };
  firstBreach: {
    stageIndex: number;
    level: number;
    metric: string;
    expression: string;
    actual: number | null;
    threshold: number | null;
  } | null;
  knee: { stageIndex: number; level: number; p95: number; strength: number } | null;
  /** Present when any stage was throttled by the safety rate cap. */
  safetyCap?: {
    rps: number | null;
    cappedStages: number[];
    /** "invalidates" when the capacity stage or any stage from the knee onward was capped. */
    impact: "invalidates" | "reduces-confidence";
  };
  /** Analysis notes (e.g. knee/USL computed without capped stages). */
  notes?: string[];
  breakpoint?: {
    lastPass: number | null;
    firstFail: number | null;
    minStep: number;
    bisectionStages: number;
    converged: boolean;
  };
  spike?: {
    baselineP95: number | null;
    peakP95: number | null;
    /** Seconds from spike end until rolling p95 is back within tolerance for 3 windows; null if not recovered. */
    recoveryTimeS: number | null;
    recovered: boolean;
    toleranceMs: number;
  };
  soak?: {
    windowMs: number;
    points: number;
    p95SlopeMsPerHour: number | null;
    ci95: [number, number] | null;
    drift: boolean;
    changePoints: { t: number; direction: "up" | "down" }[];
  };
  usl?: UslEstimate;
  /** Chart data, valid stages only, in ascending level order. */
  curves: { level: number[]; throughput: number[]; p95: number[]; p99: number[]; errorRate: number[] };
  environment?: EnvironmentFingerprint;
  methods: Record<string, string>;
}
