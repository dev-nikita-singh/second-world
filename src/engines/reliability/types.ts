/**
 * ReliabilityData: payload of a Reliability Lab EngineResult. See docs/03-engines/reliability-lab.md §2–§3.
 * Times are ms relative to the fault start of each run (negative = steady state).
 */
import type {
  Amplification,
  BreakerResult,
  IsolationResult,
  PhaseStats,
  RecoveryResult,
  SyncRetryResult,
  TimeoutAssessment,
  WindowStat,
} from "./detectors.js";
import type { InvariantResult, RouteOpCounts } from "./invariants.js";

export interface ThresholdCheck {
  expression: string;
  actual: number;
  passed: boolean;
  phase: "steady" | "fault";
}

export interface Detection {
  ruleId: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  description: string;
  recommendation?: string;
  metrics: { metric: string; value: number; unit: string }[];
  /** Threshold-type rules are classified threshold-breach; detector rules observation / reproduced-defect. */
  kind: "detector" | "threshold";
  /** Groups hits across repetitions (default: ruleId). */
  group?: string;
  /** Extra evidence notes (already scrubbed of secrets). */
  notes?: string[];
}

export interface RunAnalysis {
  index: number;
  steadyOk: boolean;
  /** Fault applied / reverted (ms relative to the fault start; reverted = actual fault duration). */
  fault: { applied: boolean; durationMs: number; abortedEarly: string | null };
  cancelled: boolean;
  steady: PhaseStats;
  during: PhaseStats;
  recoveryPhase: PhaseStats;
  routes: { route: string; steady: PhaseStats; during: PhaseStats }[];
  windows: WindowStat[];
  recovery: RecoveryResult | null;
  amplification: Amplification | null;
  jitter: SyncRetryResult | null;
  breaker: BreakerResult | null;
  timeout: TimeoutAssessment | null;
  isolation: IsolationResult[];
  checks: ThresholdCheck[];
  detections: Detection[];
  /** Duplicate-operation invariants evaluated after the recovery phase (absent when none configured). */
  invariants?: InvariantResult[];
  /** Logical operations per route (routes with idempotency or referenced by an invariant). */
  operations?: Record<string, RouteOpCounts>;
}

export interface ReliabilityData {
  schema: 1;
  scenario: string;
  dependency: string;
  injector: string;
  faults: string[];
  environment: string;
  phases: { steadyMs: number; faultMs: number; recoveryMs: number };
  workload: { rate: number; arrival: string; routes: string[] };
  repeat: number;
  /** held: hypothesis held in every run; violated: some run broke it; inconclusive: steady state not met / cancelled. */
  verdict: "held" | "violated" | "inconclusive";
  /** Rule hits across repetitions. */
  reproduced: { ruleId: string; hits: number; runs: number }[];
  runs: RunAnalysis[];
  methods: Record<string, string>;
}
