/**
 * HTTP API types shared by the `sw ui` server (src/ui/server) and the browser app (src/ui/web).
 * Types only: this file must stay free of runtime code and Node/DOM imports (both sides compile it).
 * Contract: .agents/PLAN-wave10.md "HTTP API contract"; docs/09-cli-and-api.md §1 "sw ui".
 */

export type UiEngineId =
  | "inspect"
  | "bugs"
  | "perf"
  | "stress"
  | "reliability"
  | "agent"
  | "whatif"
  | "model";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface OptionSpec {
  /** Key in `JobRequest.options`. */
  name: string;
  label: string;
  help: string;
  kind: "number" | "duration" | "enum" | "multi" | "boolean" | "text";
  choices?: string[];
  /** Display names for `choices` (value → label). */
  choiceLabels?: Record<string, string>;
  default?: string | number | boolean | string[];
  /** Shown under "Advanced". */
  advanced?: boolean;
  min?: number;
  max?: number;
  /** Required before Start is enabled. */
  required?: boolean;
  /** Turning this option on needs a confirmation of that kind. */
  confirms?: "mutations" | "disruptive";
}

export interface EngineInfo {
  id: UiEngineId;
  title: string;
  /** One sentence: what it does. */
  summary: string;
  /** e.g. "about 15 s". */
  typicalDuration: string;
  /** False when the config lacks what the engine needs (`notConfiguredReason` says what). */
  configured: boolean;
  notConfiguredReason?: string;
  /** Confirmations every run of this engine needs (independent of options). */
  needs: Array<"mutations" | "disruptive">;
  options: OptionSpec[];
}

export interface TargetInfo {
  name: string;
  url: string;
  role?: string;
  health: { ok: boolean; status?: number; ms?: number; error?: string; checked: boolean };
}

export interface SessionInfo {
  version: string;
  project: { name: string; root: string; configPath: string | null };
  engines: EngineInfo[];
  history: { enabled: boolean; backend: string; dir: string };
  running: RunJob | null;
  /** Config problems (load errors, warnings) to show as banners. */
  warnings: string[];
}

export interface RunSummary {
  id: string;
  createdAt: string;
  /** Engine ids of the stored results (history `engines`). */
  engines: string[];
  label?: string;
  status: string;
  findings: { total: number; maxSeverity: Severity | null };
  p95Ms?: number;
  compacted?: boolean;
}

export interface RunsPage {
  runs: RunSummary[];
  /** Pass as `before` for the next page; null at the end. */
  next: string | null;
}

export interface RunDetail {
  run: RunSummary;
  /** The combined report (kind "second-world-report"), redacted. */
  report: unknown;
  /** Exit code the run would have produced and its meaning. */
  exitCode: number;
  exitMeaning: string;
}

export interface FindingGroup {
  fingerprint: string;
  ruleId?: string;
  title: string;
  severity: Severity;
  classification: string;
  engine: string;
  where?: string;
  firstSeen: string;
  lastSeen: string;
  /** Number of runs that reported it (within the scanned window). */
  runs: number;
  /** Reported by the latest scanned run of the same engine. */
  open: boolean;
  lastRunId: string;
}

export interface FindingsPage {
  findings: FindingGroup[];
  /** How many most-recent runs were scanned. */
  scannedRuns: number;
}

export interface JobRequest {
  engine: UiEngineId;
  options?: Record<string, unknown>;
  confirm?: { mutations?: boolean; disruptive?: boolean };
  dryRun?: boolean;
  label?: string;
}

export interface RunJob {
  id: string;
  engine: UiEngineId | "replay";
  /** The equivalent command line (display only). */
  command: string;
  startedAt: string;
  endedAt?: string;
  state: "running" | "stopping" | "finished";
  exitCode?: number;
  exitMeaning?: string;
  /** History id of the saved run, when the command saved one. */
  runId?: string;
  dryRun?: boolean;
}

export interface JobLine {
  stream: "stdout" | "stderr";
  text: string;
}

export interface ApiError {
  error: { code: string; message: string; needs?: Array<"mutations" | "disruptive">; issues?: string[] };
}
