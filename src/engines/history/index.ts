/**
 * Experiment History public entry. See docs/03-engines/evidence-and-history.md Part B.
 * Backends: JSONL (default, always available), SQLite (`backend: "sqlite"`, node:sqlite, loaded lazily;
 * falls back to JSONL with a warning when node:sqlite is unavailable) and plugin stores registered
 * with `registerHistoryBackend`. The `HistoryStore` interface (store.ts) is the contract for all three.
 */
import path from "node:path";
import { compareRuns, diffFindings, PRIMARY_METRICS, trendAnalysis } from "./compare.js";
import { captureGitMetadata } from "./git.js";
import { createJsonlStore, type JsonlStoreOptions } from "./jsonl-store.js";
import { extractMetrics, metricDirection, overallStatus } from "./metrics.js";
import { migrateRun } from "./migrations.js";
import { getHistoryBackend } from "./registry.js";
import { HistoryError, type HistoryStore } from "./store.js";

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
export { createJsonlStore, type JsonlStoreOptions } from "./jsonl-store.js";
export { extractMetrics, metricDirection, overallStatus } from "./metrics.js";
export { migrateRun, UnsupportedSchemaError } from "./migrations.js";
export {
  BUILTIN_HISTORY_BACKENDS,
  getHistoryBackend,
  type HistoryStoreFactory,
  type HistoryStoreFactoryOptions,
  listHistoryBackends,
  registerHistoryBackend,
} from "./registry.js";
export { HistoryError, type HistoryStore, isIndexEntry } from "./store.js";
export type * from "./types.js";
export { HISTORY_SCHEMA_VERSION } from "./types.js";

export interface CreateHistoryStoreOptions extends JsonlStoreOptions {
  /** "jsonl" (default), "sqlite", or the name of a backend registered with `registerHistoryBackend`. */
  backend?: string;
  /** Options passed to a registered (plugin) backend. */
  options?: Record<string, unknown>;
  /** Test seam (sqlite): replaces the node:sqlite loader; resolve null to simulate "unavailable". */
  loadSqlite?: () => Promise<typeof import("node:sqlite") | null>;
}

export type HistoryStoreWithInfo = HistoryStore & {
  /** Set when the requested backend could not be used and JSONL is used instead. */
  readonly fallbackReason?: string;
  /** Resolves once the backend is open (lazy backends load on first use). */
  ready(): Promise<void>;
  /** Releases backend resources (SQLite: the cached connection). Safe to call any time; the store stays usable. */
  close(): Promise<void>;
};

const METHODS = [
  "append",
  "get",
  "list",
  "query",
  "setBaseline",
  "getBaseline",
  "listBaselines",
  "diff",
  "trend",
  "verify",
  "prune",
] as const satisfies readonly (keyof HistoryStore)[];

/**
 * Creates the history store for `backend`. Synchronous: JSONL is returned directly; SQLite and
 * plugin backends are opened lazily on the first call (so nothing loads node:sqlite until history
 * is actually used). Use `openHistoryStore` to open eagerly.
 */
export function createHistoryStore(opts: CreateHistoryStoreOptions = {}): HistoryStoreWithInfo {
  const { backend = "jsonl", options, loadSqlite, ...rest } = opts;
  if (backend === "jsonl")
    return Object.assign(createJsonlStore(rest), { ready: async () => {}, close: async () => {} });
  const cwd = rest.cwd ?? process.cwd();
  const dir = rest.dir ?? path.join(cwd, ".second-world", "history");
  let inner: HistoryStore | undefined;
  let fallbackReason: string | undefined;
  let opening: Promise<HistoryStore> | undefined;

  async function resolve(): Promise<HistoryStore> {
    if (backend === "sqlite") {
      const m = await import("./sqlite-store.js");
      try {
        return await m.createSqliteStore({ ...rest, cwd, dir, ...(loadSqlite ? { loadSqlite } : {}) });
      } catch (e) {
        if (!(e instanceof m.SqliteUnavailableError)) throw e;
        fallbackReason = `history.backend "sqlite": ${e.message}; using the JSONL history in ${dir} instead (runs stored in ${m.SQLITE_FILE} are not visible until node:sqlite is available)`;
        rest.onWarning?.(fallbackReason);
        return createJsonlStore({ ...rest, cwd, dir });
      }
    }
    const factory = getHistoryBackend(backend);
    if (!factory)
      throw new HistoryError(
        "SW_HISTORY_BACKEND",
        `Unknown history backend "${backend}": use "jsonl", "sqlite" or a backend registered by a plugin`,
      );
    return factory({ ...rest, cwd, dir, ...(options ? { options } : {}) });
  }

  const open = (): Promise<HistoryStore> => {
    if (inner) return Promise.resolve(inner);
    opening ??= resolve().then(
      (s) => {
        inner = s;
        return s;
      },
      (e: unknown) => {
        opening = undefined; // a later call may retry (e.g. after a busy database)
        throw e;
      },
    );
    return opening;
  };

  const lazy = {
    get backend() {
      return inner?.backend ?? backend;
    },
    get dir() {
      return inner?.dir ?? dir;
    },
    get fallbackReason() {
      return fallbackReason;
    },
    async ready() {
      await open();
    },
    async close() {
      const s = inner as (HistoryStore & { close?: () => Promise<void> }) | undefined;
      if (typeof s?.close === "function") await s.close();
    },
  } as HistoryStoreWithInfo;
  for (const name of METHODS)
    Object.defineProperty(lazy, name, {
      enumerable: true,
      value: async (...args: unknown[]) => {
        const s = await open();
        return (s[name] as (...a: unknown[]) => Promise<unknown>).apply(s, args);
      },
    });
  return lazy;
}

/** Like `createHistoryStore`, but opens the backend now (fallbackReason/backend are final). */
export async function openHistoryStore(opts: CreateHistoryStoreOptions = {}): Promise<HistoryStoreWithInfo> {
  const s = createHistoryStore(opts);
  await s.ready();
  return s;
}

export const HISTORY_ENGINE_VERSION = "0.1.0";

/** Facade for world.history.* wiring. */
export const historyEngine = {
  id: "history" as const,
  version: HISTORY_ENGINE_VERSION,
  createStore: createHistoryStore,
  openStore: openHistoryStore,
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
