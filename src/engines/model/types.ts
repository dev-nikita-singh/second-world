/**
 * System Model (Digital Twin) schema — docs/03-engines/system-model.md §2.
 * Versioned with `MODEL_SCHEMA_VERSION`; bump on breaking changes (diffModels refuses mismatches).
 */
import type { Limitation, Severity, TimeRange } from "../../core/evidence/schemas.js";

export const MODEL_SCHEMA_VERSION = 1 as const;

export type ModelNodeKind =
  | "service"
  | "route"
  | "handler"
  | "datastore"
  | "cache"
  | "queue"
  | "external"
  | "module";
export type ModelEdgeKind = "calls" | "reads" | "writes" | "publishes" | "consumes" | "depends";

/** Evidence source families (spec §1 trust table). */
export type SourceKind =
  | "trace"
  | "metrics"
  | "experiment"
  | "performance"
  | "openapi"
  | "config"
  | "static"
  | "static-heuristic"
  | "finding";

export interface ModelEvidence {
  source: SourceKind;
  confidence: number;
  /** Where it came from: file path, `otlp`, `prometheus`, `performance:<runId>`, … (POSIX, project-relative when possible). */
  origin: string;
  /** Human-readable statement, e.g. `fetch POST in charge()`, `peer.service=payments`. */
  detail: string;
  line?: number;
  /** Occurrence count (e.g. spans observed). */
  count?: number;
  /** Up to 5 example trace ids (trace evidence). */
  traceIds?: string[];
}

export interface ObservedNodeMetrics {
  rps?: number;
  p95Ms?: number;
  errorRate?: number;
  requests?: number;
  window: TimeRange;
  /** Which source produced these numbers. */
  source: "trace" | "metrics" | "performance";
}

export interface ObservedEdgeMetrics {
  callsPerRequest?: number;
  p95Ms?: number;
  calls?: number;
  errorRate?: number;
}

export interface FailureMode {
  id: string;
  title: string;
  source: string;
  severity?: Severity;
  classification?: string;
  fingerprint?: string;
}

export interface ModelNode {
  id: string;
  kind: ModelNodeKind;
  /** Canonical display name first, then aliases (sorted). */
  names: string[];
  evidence: ModelEvidence[];
  confidence: number;
  /** Owning service node id (routes/handlers). */
  service?: string;
  /** Route nodes: HTTP method + path template (OpenAPI `{param}` style). */
  method?: string;
  path?: string;
  /** Normalised `host:port` identities. */
  hosts?: string[];
  observed?: ObservedNodeMetrics;
  failureModes?: FailureMode[];
  /** Includes at least one fuzzy (name-similarity) merge. */
  proposedMerge?: boolean;
}

export interface ModelEdge {
  id: string;
  from: string;
  to: string;
  kind: ModelEdgeKind;
  evidence: ModelEvidence[];
  confidence: number;
  observed?: ObservedEdgeMetrics;
}

export type MergeRule =
  | "same-key"
  | "host-port"
  | "service-name"
  | "env-url"
  | "trace-link"
  | "k8s-selector"
  | "route-signature"
  | "name-similarity";

export interface MergeRecord {
  /** Resulting node id. */
  node: string;
  rule: MergeRule;
  /** The two observation keys whose sets were united. */
  a: string;
  b: string;
  /** Matching token or similarity detail, e.g. `127.0.0.1:4010`, `jw=0.95 payment~payments`. */
  detail: string;
  /** 1 for exact rules; < 1 for proposed (fuzzy) merges. */
  confidence: number;
  proposed: boolean;
}

export type CoverageSource =
  | "static"
  | "openapi"
  | "config"
  | "traces"
  | "metrics"
  | "performance"
  | "experiments";

export interface Coverage {
  sources: Record<CoverageSource, boolean>;
  /** e.g. "Built from: static analysis ✓, OpenAPI ✓, runtime traces ✗ … Production topology unknown." */
  banner: string;
  bannerAscii: string;
  runtimeObserved: boolean;
}

export interface CriticalPathSegment {
  spanId: string;
  name: string;
  service: string;
  /** Model node id the time is attributed to (service self-time or a dependency). */
  node?: string;
  ms: number;
}

export interface CriticalPath {
  traceId: string;
  rootSpanId: string;
  root: string;
  /** Route node id when the root is a server span with a known route. */
  route?: string;
  durationMs: number;
  /** Merged per span, in time order. */
  segments: CriticalPathSegment[];
  /** Critical-path time per model node id (descending). */
  byNode: { node: string; ms: number; share: number }[];
}

export interface DominantDependency {
  route: string;
  node: string;
  ms: number;
  share: number;
  traces: number;
}

export interface TraceSummary {
  traces: number;
  spans: number;
  services: string[];
  orphanSpans: number;
  droppedSpans: number;
  window?: TimeRange;
  criticalPaths: CriticalPath[];
  dominant: DominantDependency[];
}

export interface ModelData {
  schemaVersion: typeof MODEL_SCHEMA_VERSION;
  builtAt: string;
  /** Primary (project) service node id, when known. */
  primaryService?: string;
  nodes: ModelNode[];
  edges: ModelEdge[];
  merges: MergeRecord[];
  coverage: Coverage;
  traces?: TraceSummary;
  stats: {
    observations: number;
    nodes: number;
    edges: number;
    merges: number;
    proposedMerges: number;
  };
  limitations: Limitation[];
}
