/**
 * Backend-neutral part of Experiment History: the `HistoryStore` contract every backend implements
 * (JSONL, SQLite, plugin stores) and the pure helpers both built-in backends share, so they behave
 * identically (one contract test suite runs against both: tests/unit/history/contract.ts).
 * See docs/03-engines/evidence-and-history.md Part B and docs/10-plugins-and-extensibility.md.
 */
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";
import { sha256 } from "../../shared/util/hash.js";
import { type CompareRunsOptions, compareRuns, type TrendOptions, trendAnalysis } from "./compare.js";
import { extractMetrics, maxSeverity, overallStatus } from "./metrics.js";
import {
  type AppendRunInput,
  type BaselineRef,
  type GitMeta,
  HISTORY_SCHEMA_VERSION,
  type HistoryRun,
  type IndexEntry,
  type ListOptions,
  type PruneOptions,
  type PruneReport,
  type QueryFilter,
  type RunComparison,
  type TrendResult,
  type VerifyReport,
} from "./types.js";

const gzip = promisify(gzipCb);

/** The store contract (CONTRACTS.md "sw-sqlite-w9"). Plugin stores implement exactly this. */
export interface HistoryStore {
  /** "jsonl" | "sqlite" for the built-in backends; a plugin store uses its registered name. */
  readonly backend: string;
  /** Directory the store keeps its data in (informational for plugin stores). */
  readonly dir: string;
  append(input: AppendRunInput): Promise<IndexEntry>;
  /** Full run by id (or unique id prefix ≥ 6 chars, or "baseline:<name>"); null when unknown or compacted. Throws HistoryError SW_HISTORY_AMBIGUOUS. */
  get(id: string): Promise<HistoryRun | null>;
  /** Index entries, newest first (createdAt, then id). */
  list(opts?: ListOptions): Promise<IndexEntry[]>;
  /** Filter (or predicate over all entries), newest first. */
  query(filter: QueryFilter | ((e: IndexEntry) => boolean)): Promise<IndexEntry[]>;
  setBaseline(name: string, runId: string): Promise<BaselineRef>;
  getBaseline(name: string): Promise<HistoryRun | null>;
  /** Sorted by name. */
  listBaselines(): Promise<BaselineRef[]>;
  /** Compare runs (ids, id prefixes or baseline names via "baseline:<name>"). */
  diff(
    baseline: string | string[],
    current: string | string[],
    opts?: CompareRunsOptions,
  ): Promise<RunComparison>;
  trend(metric: string, filters?: QueryFilter & { endpoint?: string } & TrendOptions): Promise<TrendResult>;
  verify(): Promise<VerifyReport>;
  prune(opts?: PruneOptions): Promise<PruneReport>;
}

export class HistoryError extends Error {
  constructor(
    readonly code:
      | "SW_HISTORY_NOT_FOUND"
      | "SW_HISTORY_AMBIGUOUS"
      | "SW_HISTORY_COMPACTED"
      | "SW_HISTORY_CORRUPT"
      | "SW_HISTORY_BAD_ID"
      | "SW_HISTORY_BACKEND",
    message: string,
  ) {
    super(message);
    this.name = "HistoryError";
  }
}

const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export const RUN_FILE = /^runs\/[A-Za-z0-9._-]+\.json\.gz$/;
export const BASELINE_NAME = /^[A-Za-z0-9._\-/]{1,100}$/;

/**
 * Structural check of an index entry. A record that parses as JSON but lacks a field the readers use
 * (hand-edited, foreign or damaged index) is treated like a torn line: skipped with a warning and
 * listed by verify, instead of crashing `sw history list` with exit 70
 * (tests/unit/robust/malformed-inputs.test.ts).
 */
export function isIndexEntry(e: unknown): e is IndexEntry {
  if (!isObj(e)) return false;
  const f = e.findings;
  return (
    typeof e.id === "string" &&
    e.id !== "" &&
    typeof e.file === "string" &&
    // Only the shape we write (runs/<id>.json.gz): a tampered index must not point reads outside
    // the history directory (docs/11 threat model).
    RUN_FILE.test(e.file) &&
    typeof e.createdAt === "string" &&
    (e.label === undefined || typeof e.label === "string") &&
    isStrArray(e.tags) &&
    isStrArray(e.engines) &&
    typeof e.status === "string" &&
    isObj(e.metrics) &&
    Object.values(e.metrics).every((m) => typeof m === "number" || m === null) &&
    isObj(f) &&
    typeof f.count === "number" &&
    isStrArray(f.fingerprints) &&
    (f.maxSeverity === null || typeof f.maxSeverity === "string") &&
    (e.git === undefined || isObj(e.git)) &&
    (e.sha256 === undefined || typeof e.sha256 === "string") &&
    (e.bytes === undefined || typeof e.bytes === "number")
  );
}

/** Oldest first: createdAt, then id (the order both backends keep). */
export function compareEntries(a: IndexEntry, b: IndexEntry): number {
  return a.createdAt < b.createdAt
    ? -1
    : a.createdAt > b.createdAt
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;
}

export function matches(e: IndexEntry, f: QueryFilter): boolean {
  if (f.includeCompacted === false && e.compacted) return false;
  if (f.engine && !e.engines.includes(f.engine)) return false;
  if (f.branch && e.git?.branch !== f.branch) return false;
  if (f.label && e.label !== f.label) return false;
  if (f.since && e.createdAt < f.since) return false;
  if (f.until && e.createdAt > f.until) return false;
  if (f.status && e.status !== f.status) return false;
  if (f.tag && !e.tags.includes(f.tag)) return false;
  if (f.hasFindings !== undefined && f.hasFindings !== e.findings.count > 0) return false;
  if (f.fingerprint && !e.findings.fingerprints.includes(f.fingerprint)) return false;
  return true;
}

/** `list`/`query` over oldest-first entries → newest first, limited. */
export function selectEntries(
  oldestFirst: readonly IndexEntry[],
  filter: QueryFilter | ((e: IndexEntry) => boolean),
): IndexEntry[] {
  const out =
    typeof filter === "function"
      ? oldestFirst.filter(filter)
      : oldestFirst.filter((e) => matches(e, { includeCompacted: true, ...filter }));
  const lim = typeof filter === "function" ? undefined : filter.limit;
  out.reverse();
  return lim !== undefined ? out.slice(0, lim) : out;
}

export function checkRunId(id: string): void {
  if (!RUN_FILE.test(`runs/${id}.json.gz`) || id.startsWith("."))
    throw new HistoryError(
      "SW_HISTORY_BAD_ID",
      `Invalid run id "${id}": use letters, digits, ".", "_" or "-"`,
    );
}

export function checkBaselineName(name: string): void {
  if (!BASELINE_NAME.test(name)) throw new Error(`Invalid baseline name "${name}"`);
}

export interface PreparedRun {
  run: HistoryRun;
  entry: IndexEntry;
  /** gzip of JSON.stringify(run): the stored report bytes (sha256 in `entry`). */
  gz: Buffer;
}

/** Builds the immutable run, its gzipped bytes and the index entry exactly as every backend stores them. */
export async function prepareRun(
  input: AppendRunInput,
  id: string,
  createdAt: string,
  git: GitMeta | undefined,
): Promise<PreparedRun> {
  checkRunId(id);
  const metrics = { ...extractMetrics(input.results), ...(input.metrics ?? {}) };
  const run: HistoryRun = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    id,
    createdAt,
    ...(input.label !== undefined ? { label: input.label } : {}),
    tags: input.tags ?? [],
    engines: [...new Set(input.results.map((r) => r.engine))],
    status: overallStatus(input.results),
    ...(git ? { git } : {}),
    metrics,
    ...(input.repetitions ? { repetitions: input.repetitions } : {}),
    results: input.results,
    ...(input.meta ? { meta: input.meta } : {}),
  };
  const gz = await gzip(Buffer.from(JSON.stringify(run), "utf8"));
  const findings = input.results.flatMap((r) => r.findings);
  const entry: IndexEntry = {
    v: HISTORY_SCHEMA_VERSION,
    id,
    createdAt,
    ...(run.label !== undefined ? { label: run.label } : {}),
    tags: run.tags,
    engines: run.engines,
    status: run.status,
    ...(git ? { git } : {}),
    metrics,
    findings: {
      count: findings.length,
      maxSeverity: maxSeverity(findings.map((f) => f.severity).filter((s) => SEVERITIES.has(s))),
      fingerprints: [...new Set(findings.map((f) => f.fingerprint))],
    },
    file: `runs/${id}.json.gz`,
    sha256: sha256(gz),
    bytes: gz.length,
  };
  return { run, entry, gz };
}

/** Resolves an exact id or a unique (case-insensitive) prefix ≥ 6 chars among `entries`. */
export function resolveIn(entries: readonly IndexEntry[], idOrPrefix: string, where: string): IndexEntry {
  const exact = entries.find((e) => e.id === idOrPrefix);
  if (exact) return exact;
  const up = idOrPrefix.toUpperCase();
  const found = up.length >= 6 ? entries.filter((e) => e.id.startsWith(up)) : [];
  if (found.length === 1) return found[0] as IndexEntry;
  if (found.length > 1)
    throw new HistoryError(
      "SW_HISTORY_AMBIGUOUS",
      `Run id prefix "${idOrPrefix}" matches ${found.length} runs`,
    );
  throw new HistoryError("SW_HISTORY_NOT_FOUND", `No run "${idOrPrefix}" in ${where}`);
}

export function compactedError(id: string): HistoryError {
  return new HistoryError(
    "SW_HISTORY_COMPACTED",
    `Run ${id} was compacted by retention; only its summary remains`,
  );
}

/** Resolves the metric name `trend` reads ("p95" → performance.http.p95; endpoint lookups). */
export function resolveTrendMetric(
  metric: string,
  endpoint: string | undefined,
  metricNames: Iterable<string>,
): string {
  if (endpoint && !metric.includes(".")) {
    for (const k of metricNames)
      if (k.startsWith("performance.endpoint.") && k.endsWith(`.${metric}`)) {
        const key = k.slice("performance.endpoint.".length, -(metric.length + 1));
        if (key === endpoint || key.endsWith(` ${endpoint}`)) return k;
      }
    return `performance.endpoint.${endpoint}.${metric}`;
  }
  return metric.includes(".") ? metric : `performance.http.${metric}`;
}

export function trendOver(
  oldestFirst: readonly IndexEntry[],
  metric: string,
  filters: QueryFilter & { endpoint?: string } & TrendOptions,
): TrendResult {
  const f: QueryFilter = { includeCompacted: true, ...filters };
  const names = new Set<string>();
  if (filters.endpoint && !metric.includes("."))
    for (const e of oldestFirst) for (const k of Object.keys(e.metrics)) names.add(k);
  const name = resolveTrendMetric(metric, filters.endpoint, names);
  let series = oldestFirst
    .filter((e) => matches(e, f) && typeof e.metrics[name] === "number")
    .map((e) => ({ runId: e.id, createdAt: e.createdAt, value: e.metrics[name] as number }));
  if (filters.limit !== undefined) series = series.slice(-filters.limit);
  return trendAnalysis(name, series, filters);
}

/** Fingerprints seen in runs older than the oldest baseline run → "regressed" classification. */
export function priorFingerprints(
  oldestFirst: readonly IndexEntry[],
  baseEntries: readonly IndexEntry[],
): Set<string> {
  const oldest = baseEntries.map((e) => e.createdAt).sort()[0] ?? "";
  const prior = new Set<string>();
  for (const e of oldestFirst)
    if (e.createdAt < oldest) for (const fp of e.findings.fingerprints) prior.add(fp);
  return prior;
}

export function diffRuns(
  A: HistoryRun[],
  B: HistoryRun[],
  prior: Set<string>,
  o: CompareRunsOptions,
): RunComparison {
  return compareRuns(A, B, { ...o, priorFingerprints: o.priorFingerprints ?? prior });
}

export interface PrunePlan {
  keep: Set<string>;
  compacted: string[];
  removed: string[];
}

/** Retention: keep the newest N, baselines and runs with findings; compact (or remove) the rest. */
export function planPrune(
  oldestFirst: readonly IndexEntry[],
  baselineRunIds: ReadonlySet<string>,
  o: PruneOptions,
): PrunePlan {
  const keepLast = o.keepLast ?? 50;
  const compact = o.compact ?? true;
  const keep = new Set<string>();
  const newestFirst = [...oldestFirst].reverse();
  for (const e of newestFirst.slice(0, keepLast)) keep.add(e.id);
  for (const e of oldestFirst) if (baselineRunIds.has(e.id) || e.findings.count > 0) keep.add(e.id);
  const compacted: string[] = [];
  const removed: string[] = [];
  for (const e of oldestFirst) {
    if (keep.has(e.id)) continue;
    if (compact) {
      if (!e.compacted) compacted.push(e.id);
    } else removed.push(e.id);
  }
  return { keep, compacted, removed };
}
