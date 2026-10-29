/**
 * Experiment History public entry. See docs/03-engines/evidence-and-history.md Part B.
 * Backends: JSONL (default, always available). `backend: "sqlite"` is accepted but currently falls
 * back to JSONL (reported via `fallbackReason`); the interface is backend-neutral.
 */
import { compareRuns, diffFindings, PRIMARY_METRICS, trendAnalysis } from "./compare.js";
import { captureGitMetadata } from "./git.js";
import { createJsonlStore, type HistoryStore, type JsonlStoreOptions } from "./jsonl-store.js";
import { extractMetrics, metricDirection, overallStatus } from "./metrics.js";
import { migrateRun } from "./migrations.js";

export type { CompareRunsOptions, TrendOptions } from "./compare.js";
export { compareRuns, diffFindings, PRIMARY_METRICS, trendAnalysis } from "./compare.js";
export {
  acquireLock,
  appendLine,
  atomicWrite,
  isStale,
  type LockInfo,
  type LockOptions,
  LockTimeoutError,
  renameWithRetry,
  withLock,
} from "./fsutil.js";
export { captureGitMetadata } from "./git.js";
export { createJsonlStore, HistoryError, type HistoryStore, type JsonlStoreOptions } from "./jsonl-store.js";
export { extractMetrics, metricDirection, overallStatus } from "./metrics.js";
export { migrateRun, UnsupportedSchemaError } from "./migrations.js";
export type * from "./types.js";
export { HISTORY_SCHEMA_VERSION } from "./types.js";

export interface CreateHistoryStoreOptions extends JsonlStoreOptions {
  backend?: "jsonl" | "sqlite";
}

export type HistoryStoreWithInfo = HistoryStore & { fallbackReason?: string };

export function createHistoryStore(opts: CreateHistoryStoreOptions = {}): HistoryStoreWithInfo {
  const { backend = "jsonl", ...rest } = opts;
  const store: HistoryStoreWithInfo = createJsonlStore(rest);
  if (backend === "sqlite") {
    store.fallbackReason = "sqlite history backend is not implemented yet; using the JSONL backend";
  }
  return store;
}

export const HISTORY_ENGINE_VERSION = "0.1.0";

/** Facade for world.history.* wiring. */
export const historyEngine = {
  id: "history" as const,
  version: HISTORY_ENGINE_VERSION,
  createStore: createHistoryStore,
  compareRuns,
  diffFindings,
  trendAnalysis,
  captureGitMetadata,
  extractMetrics,
  metricDirection,
  overallStatus,
  migrateRun,
  PRIMARY_METRICS,
};
