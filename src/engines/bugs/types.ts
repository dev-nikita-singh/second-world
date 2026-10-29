/**
 * BugsData: the API Bug Hunter result payload (docs/03-engines/api-bug-hunter.md §7):
 * per-operation pass/fail matrix, coverage, findings with replay statistics, reproductions,
 * draft contract in discovery mode.
 */
import type { BugCase } from "./cases.js";
import type { Technique } from "./schema.js";

export interface TechniqueCell {
  cases: number;
  passed: number;
  failed: number;
  inconclusive: number;
}

export interface OperationRow {
  operation: string;
  verdict: "pass" | "fail" | "untested";
  techniques: Partial<Record<Technique | "discovery", TechniqueCell>>;
  /** Observed status → count. */
  statuses: Record<string, number>;
  documentedStatuses: string[];
  findings: string[];
}

export interface BugFindingSummary {
  id: string;
  fingerprint: string;
  ruleId: string;
  operation: string;
  technique: string;
  classification: "reproduced-defect" | "observation";
  severity: string;
  title: string;
  flaky: boolean;
  /** Replay failures / conclusive replay runs. */
  failures: number;
  replays: number;
  rate: number;
  wilson: { lower: number; upper: number };
  occurrences: number;
  minimized: boolean;
}

export interface ReproductionArtifact {
  fingerprint: string;
  ruleId: string;
  operation: string;
  seed: number;
  case: BugCase;
  /** Redacted exchanges of the first failing run (bodies truncated). */
  exchanges: {
    step: number;
    method: string;
    url: string;
    status: number;
    requestHeaders: Record<string, string>;
    requestBody?: string;
    responseHeaders: Record<string, string>;
    responseBody?: string;
    durationMs: number;
    error?: string;
  }[];
  curl: string[];
  message: string;
}

export interface BugsData {
  mode: "contract" | "discovery";
  target: string;
  seed: number;
  contract?: { source: string; version: string; title?: string; hash: string; operations: number };
  techniques: Technique[];
  matrix: OperationRow[];
  coverage: {
    operations: { total: number; exercised: number };
    statuses: { documented: number; observed: number };
    techniques: Partial<Record<Technique | "discovery", number>>;
    ratio: number;
  };
  findings: BugFindingSummary[];
  /** fingerprint → reproduction (also written to artifactsDir when configured). */
  reproductions: Record<string, ReproductionArtifact>;
  requests: {
    sent: number;
    mutationsBlocked: number;
    rateLimited: number;
    transportErrors: number;
    replays: number;
    hookRuns: number;
  };
  mutationsAllowed: boolean;
  /** Discovery mode only: observed shapes as an OpenAPI 3.1 draft. */
  draftContract?: Record<string, unknown>;
  /** Dictionary of harvested / configured values (ids) used for generation. */
  dictionary: Record<string, unknown[]>;
  durationMs: number;
}
