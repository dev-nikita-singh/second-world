/**
 * Result payloads of the What-If engine (ExperimentData) and the Evolution engine (EvolutionData).
 * docs/03-engines/experiments.md §A.4 (verdicts with CI), §B.4 (Pareto front, rejections).
 * Latency values are milliseconds; rates per second; ratios 0..1; relative changes are fractions
 * ((variant − baseline)/|baseline|).
 */
import type { HypothesisStatus, MetricComparison } from "./analysis.js";
import type { Projection } from "./projection.js";
import type { ScheduledRun } from "./schedule.js";

export interface ArmFingerprint {
  /** 16-hex fingerprint over host, CPU, OS, Node version, dataset hash, sandbox limits. */
  hash: string;
  host?: string | undefined;
  os?: string | undefined;
  cpu?: string | undefined;
  cpus?: number | undefined;
  node?: string | undefined;
  dataset: string;
  sandbox?: string | undefined;
}

export interface ArmSummary {
  name: string;
  /** "process": started per run/arm; "external": already-running target; "endpoint": no target of its own (uses the workload target). */
  kind: "process" | "external" | "endpoint";
  /** Arms sharing the same start spec (same process, e.g. two endpoints on one app). */
  sharesProcessWith: string[];
  command?: string | undefined;
  target?: string | undefined;
  description?: string | undefined;
  fingerprint: ArmFingerprint | null;
  runs: number;
  failedRuns: number;
  /** Median of the per-run values, per metric. */
  medians: Record<string, number>;
}

export interface RunRecord {
  index: number;
  arm: string;
  rep: number;
  block: number;
  status: "ok" | "error" | "cancelled";
  perfRunId?: string | undefined;
  /** URL the workload ran against. */
  target?: string | undefined;
  startupMs?: number | undefined;
  durationMs: number;
  metrics: Record<string, number>;
  /** Metrics for which this run is a MAD z > 3.5 outlier within its arm (flagged, never dropped). */
  outlierMetrics: string[];
  generatorSaturated?: boolean | undefined;
  error?: string | undefined;
}

export interface VariantVerdict {
  variant: string;
  hypothesis: HypothesisStatus;
  improved: string[];
  regressed: string[];
  inconclusive: string[];
}

export interface ExperimentData {
  schema: 1;
  name: string;
  hypothesis?: string | undefined;
  mode: "compare" | "aa";
  design: {
    repetitions: number;
    order: "interleaved" | "randomized-blocks" | "sequential";
    seed: number;
    lifecycle: "per-run" | "per-arm";
    alpha: number;
    bootstrap: number;
    equivalenceMargin: number;
  };
  schedule: ScheduledRun[];
  arms: ArmSummary[];
  runs: RunRecord[];
  metrics: { name: string; direction: "lower-is-better" | "higher-is-better"; unit: string }[];
  /** One row per (variant, metric) — the per-metric verdict table. */
  comparisons: MetricComparison[];
  verdicts: VariantVerdict[];
  /** A/A mode: minimum detectable relative effect per metric at this r (noise floor of the environment). */
  noiseFloor?: { metric: string; mde: number; relativeSd: number; recommendedFor5pct: number }[];
  fingerprints: { consistent: boolean; warnings: string[] };
  /** Labelled estimates (never measurements). */
  projections: Projection[];
  warnings: string[];
  methods: Record<string, string>;
}

export type CandidateKind = "branch" | "commit" | "patch";

export interface GateResult {
  gate: "worktree" | "install" | "build" | "test" | "replay" | "invariant" | "start" | "benchmark";
  name: string;
  ok: boolean;
  durationMs: number;
  detail?: string | undefined;
  skipped?: boolean | undefined;
}

export interface CandidateResult {
  /** As given: "branch:fix/a". */
  ref: string;
  name: string;
  kind: CandidateKind;
  commit?: string | undefined;
  diff: { files: number; insertions: number; deletions: number; lines: number; stat: string };
  gates: GateResult[];
  status: "accepted" | "rejected" | "error";
  rejectionReasons: string[];
  /** Benchmark: oriented relative improvement per rank metric (+ = better). */
  improvement: Record<string, number>;
  medians: Record<string, number>;
  verdicts: Record<string, string>;
  score?: number | undefined;
  pareto: boolean;
  rank?: number | undefined;
  dominatedBy: string[];
}

export interface EvolutionData {
  schema: 1;
  repo: string;
  baseline: { ref: string; commit: string };
  finding?: string | undefined;
  sandbox: {
    kind: "docker" | "process";
    image?: string | undefined;
    cpus?: number | undefined;
    memory?: string | undefined;
    network?: string | undefined;
  };
  install: { strategy: string; lockfileHash?: string | undefined; reused: number; installed: number };
  candidates: CandidateResult[];
  rankBy: { metric: string; direction: "lower-is-better" | "higher-is-better"; weight: number }[];
  /** Names of non-dominated accepted candidates, best first. */
  paretoFront: string[];
  rejected: { name: string; reasons: string[] }[];
  /** The embedded What-If experiment (baseline vs accepted candidates), when any candidate passed the gates. */
  experiment?: ExperimentData | undefined;
  workingTree: { before: string; after: string; unchanged: boolean };
  worktreesCleaned: boolean;
  warnings: string[];
  methods: Record<string, string>;
}
