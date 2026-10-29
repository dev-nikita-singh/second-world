/**
 * Experiment History types. See docs/03-engines/evidence-and-history.md Part B.
 */
import type { EngineId, EngineResult, Finding, Severity } from "../../core/evidence/schemas.js";

export const HISTORY_SCHEMA_VERSION = 1 as const;

export interface GitMeta {
  commit: string;
  branch: string | null;
  dirty: boolean;
}

/** Full stored run (runs/<ulid>.json.gz). Immutable once written. */
export interface HistoryRun {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  label?: string;
  tags: string[];
  engines: EngineId[];
  status: EngineResult["status"];
  git?: GitMeta;
  /** Flattened summary metrics, e.g. "performance.http.p95" (ms). */
  metrics: Record<string, number>;
  /** Per-repetition samples per metric (when the run repeated measurements). */
  repetitions?: Record<string, number[]>;
  results: EngineResult[];
  meta?: Record<string, unknown>;
}

/** One line of runs.jsonl. */
export interface IndexEntry {
  v: typeof HISTORY_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  label?: string;
  tags: string[];
  engines: EngineId[];
  status: EngineResult["status"];
  git?: GitMeta;
  metrics: Record<string, number>;
  findings: { count: number; maxSeverity: Severity | null; fingerprints: string[] };
  /** Relative path of the report file (POSIX separators). */
  file: string;
  /** sha256 (hex) of the stored .json.gz bytes. */
  sha256: string;
  bytes: number;
  /** Report file removed by retention; summary kept. */
  compacted?: boolean;
}

export interface AppendRunInput {
  results: EngineResult[];
  label?: string;
  tags?: string[];
  /** Git metadata; `false` skips capture; undefined captures from `cwd`. */
  git?: GitMeta | false;
  createdAt?: string;
  id?: string;
  /** Extra metrics merged over the extracted ones. */
  metrics?: Record<string, number>;
  repetitions?: Record<string, number[]>;
  meta?: Record<string, unknown>;
}

export interface ListOptions {
  limit?: number;
  engine?: EngineId;
  branch?: string;
  label?: string;
  includeCompacted?: boolean;
}

export interface QueryFilter extends ListOptions {
  since?: string;
  until?: string;
  status?: EngineResult["status"];
  tag?: string;
  hasFindings?: boolean;
  fingerprint?: string;
}

export interface VerifyIssue {
  id?: string;
  line?: number;
  file?: string;
  problem:
    | "corrupt-index-line"
    | "missing-report"
    | "checksum-mismatch"
    | "unreadable-report"
    | "id-mismatch"
    | "orphan-report"
    | "leftover-temp"
    | "baseline-missing-run";
  detail?: string;
}

export interface VerifyReport {
  ok: boolean;
  checked: number;
  /** Problems that indicate corruption/tampering. */
  errors: VerifyIssue[];
  /** Harmless leftovers (orphans from a crash between write and index append, temp files). */
  warnings: VerifyIssue[];
}

export interface PruneOptions {
  /** Keep the newest N runs. Default 50. */
  keepLast?: number;
  /** Compact (drop report file, keep index summary) instead of removing entirely. Default true. */
  compact?: boolean;
  dryRun?: boolean;
}

export interface PruneReport {
  kept: number;
  compacted: string[];
  removed: string[];
  dryRun: boolean;
}

export interface BaselineRef {
  name: string;
  runId: string;
  setAt: string;
}

export type FindingDiffStatus = "new" | "fixed" | "regressed" | "unchanged";

export interface FindingDiffEntry {
  fingerprint: string;
  status: FindingDiffStatus;
  title: string;
  engine: EngineId;
  severity: Severity;
  baseline?: Finding;
  current?: Finding;
}

export interface FindingDiff {
  new: FindingDiffEntry[];
  fixed: FindingDiffEntry[];
  regressed: FindingDiffEntry[];
  unchanged: FindingDiffEntry[];
}

export type MetricVerdict = "improved" | "regressed" | "no-significant-change" | "inconclusive";

export interface MetricComparison {
  metric: string;
  direction: "lower-is-better" | "higher-is-better";
  /** "statistical": per-run summaries, compareSamples (bootstrap CI + Mann–Whitney + Holm).
   *  "single-run": one value per arm, no statistics — never a significance claim. */
  method: "statistical" | "single-run";
  baseline: number;
  current: number;
  relativeChange: number;
  verdict: MetricVerdict;
  /** single-run only: which way the point estimate moved beyond `changeThreshold`. */
  movement?: "worse" | "better" | "within-threshold";
  ci95?: [number, number];
  p?: number;
  pAdjusted?: number;
  n?: { baseline: number; current: number };
  cliffsDelta?: number;
  note?: string;
}

export interface RunComparison {
  baselineIds: string[];
  currentIds: string[];
  method: "statistical" | "single-run" | "mixed";
  metrics: MetricComparison[];
  findings: FindingDiff;
  regressions: string[];
  summary: string;
}

export interface TrendPoint {
  runId: string;
  createdAt: string;
  value: number;
  z: number | null;
  anomaly: boolean;
  changePoint?: "up" | "down";
}

export interface TrendResult {
  metric: string;
  points: TrendPoint[];
  anomalies: TrendPoint[];
  changePoints: TrendPoint[];
  method: string;
}
