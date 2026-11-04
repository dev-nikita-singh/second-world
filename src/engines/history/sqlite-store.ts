/**
 * SQLite history backend (`history.backend: "sqlite"`), built on `node:sqlite` (Node ≥ 22.13).
 * See docs/03-engines/evidence-and-history.md §B.1 "SQLite backend" and ADR 008 (docs/02).
 *
 * Same contract and observable behaviour as the JSONL store (tests/unit/history/contract.ts runs one
 * suite against both): same ids, ordering, filters, prefix/baseline resolution, errors, retention,
 * gzip report bytes + sha256, verify problems.
 *
 * File: `<dir>/history.db` (+ `-wal`/`-shm` while open). Tables (schema v1):
 *   runs(id PK, created_at, label, status, branch, compacted, finding_count, entry JSON, sha256, bytes)
 *   reports(run_id PK, report BLOB gzip) — kept apart so index scans stay on small rows
 *   run_metrics(name, created_at, run_id, ord, value) — one row per numeric metric; trend reads the PK
 *   metric_names(name PK, first) — first appearance (created_at, id, key order) for endpoint lookups
 *   baselines(name PK, run_id, set_at), meta(key PK, value), jsonl_imported(id PK)
 *   schema_migrations(version PK, name, applied_at) + PRAGMA user_version
 *
 * Concurrency / crash safety: WAL journal, `busy_timeout` (default 10 s, `lock.timeoutMs`), every write
 * in one `BEGIN IMMEDIATE` transaction. A connection lives for one operation only (open → work →
 * close, all synchronous, no await in between), so no handle outlives a call and two processes never
 * see a half-written run. A writer killed mid-transaction leaves the previous committed state; SQLite
 * rolls the WAL back on the next open.
 *
 * JSONL import: when `<dir>/runs.jsonl` exists, its runs (report bytes copied verbatim, so sha256 stays
 * the same) and baselines are imported once per id; the import re-runs only when runs.jsonl changed
 * (size/mtime), skips ids imported before (so retention in SQLite is not undone) and never modifies the
 * JSONL files. Going back to JSONL: `exportSqliteHistoryToJsonl()`.
 */
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCb } from "node:zlib";
import { sha256 } from "../../shared/util/hash.js";
import { ulid } from "../../shared/util/ulid.js";
import { trendAnalysis } from "./compare.js";
import { appendLine, atomicWrite, type LockOptions } from "./fsutil.js";
import { captureGitMetadata } from "./git.js";
import { migrateRun, UnsupportedSchemaError } from "./migrations.js";
import { loadNodeSqlite, nodeSqliteUnavailableReason } from "./sqlite-load.js";
import {
  checkBaselineName,
  compactedError,
  compareEntries,
  diffRuns,
  HistoryError,
  type HistoryStore,
  isIndexEntry,
  isObj,
  planPrune,
  prepareRun,
  priorFingerprints,
  resolveTrendMetric,
  selectEntries,
} from "./store.js";
import type {
  BaselineRef,
  HistoryRun,
  IndexEntry,
  QueryFilter,
  TrendResult,
  VerifyIssue,
  VerifyReport,
} from "./types.js";

const gunzip = promisify(gunzipCb);

type SqliteModule = typeof import("node:sqlite");
type Db = InstanceType<SqliteModule["DatabaseSync"]>;
type SqlValue = string | number | null | Uint8Array;

export const SQLITE_FILE = "history.db";
/** Latest DB schema version (PRAGMA user_version + schema_migrations). */
export const SQLITE_SCHEMA_VERSION = 1;
/** A store's connection is closed after this long without use. */
const IDLE_MS = 50;

export interface SqliteStoreOptions {
  cwd?: string;
  dir?: string;
  /** `timeoutMs` → SQLite busy_timeout (default 10 s). Other fields are JSONL-only. */
  lock?: LockOptions;
  newId?: () => string;
  isoNow?: () => string;
  captureGit?: boolean;
  onWarning?: (message: string) => void;
  /** Import an existing JSONL history in `dir` (default true). */
  importJsonl?: boolean;
  /** Test seam: replaces the node:sqlite loader. */
  loadSqlite?: () => Promise<SqliteModule | null>;
}

/** node:sqlite cannot be loaded in this runtime; the caller falls back to JSONL. */
export class SqliteUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`node:sqlite is not available in this runtime (${reason})`);
    this.name = "SqliteUnavailableError";
  }
}

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Append-only: never edit a shipped migration, add the next version. */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL,
  branch TEXT,
  compacted INTEGER NOT NULL DEFAULT 0,
  finding_count INTEGER NOT NULL DEFAULT 0,
  entry TEXT NOT NULL,
  sha256 TEXT,
  bytes INTEGER
);
CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at, id);
CREATE TABLE IF NOT EXISTS reports (run_id TEXT PRIMARY KEY NOT NULL, report BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS run_metrics (
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  run_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (name, created_at, run_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS run_metrics_run ON run_metrics(run_id);
CREATE TABLE IF NOT EXISTS metric_names (name TEXT PRIMARY KEY NOT NULL, first TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS baselines (name TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, set_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jsonl_imported (id TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID;
`,
  },
];

const RUN_WITH_REPORT = `SELECT runs.id AS id, runs.entry AS entry, reports.report AS report FROM runs
  LEFT JOIN reports ON reports.run_id = runs.id WHERE runs.id = ?`;

/** Sortable "first appearance" key: created_at, id, key order (same encoding as rebuildMetricNames). */
function firstKey(createdAt: string, id: string, ord: number): string {
  return `${createdAt}\u0001${id}\u0001${String(ord).padStart(8, "0")}`;
}

interface RunRow {
  id: string;
  entry: string;
  report?: Uint8Array | null;
}

function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back by SQLite
    }
    throw e;
  }
}

/** Parse a stored entry; null when the JSON is not an index entry (reported by verify). */
function parseEntry(row: { id: string; entry: string; compacted?: number }): IndexEntry | null {
  try {
    const e = JSON.parse(row.entry) as unknown;
    if (!isIndexEntry(e) || e.id !== row.id) return null;
    return e;
  } catch {
    return null;
  }
}

/** The SQLite store: the HistoryStore contract plus `close()` (releases the cached connection now). */
export type SqliteHistoryStore = HistoryStore & { close(): Promise<void> };

export async function createSqliteStore(opts: SqliteStoreOptions = {}): Promise<SqliteHistoryStore> {
  const sqlite = await (opts.loadSqlite ?? loadNodeSqlite)();
  if (!sqlite) throw new SqliteUnavailableError(nodeSqliteUnavailableReason() ?? "module not found");
  const { DatabaseSync } = sqlite;
  const cwd = opts.cwd ?? process.cwd();
  const dir = opts.dir ?? path.join(cwd, ".second-world", "history");
  const dbFile = path.join(dir, SQLITE_FILE);
  const indexFile = path.join(dir, "runs.jsonl");
  const newId = opts.newId ?? (() => ulid());
  const isoNow = opts.isoNow ?? (() => new Date().toISOString());
  const busyMs = Math.max(0, Math.floor(opts.lock?.timeoutMs ?? 10_000));
  const importJsonl = opts.importJsonl !== false;
  await mkdir(dir, { recursive: true });

  const warned = new Set<string>();
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    opts.onWarning?.(message);
  };

  function corrupt(err: unknown): HistoryError {
    if (err instanceof HistoryError) return err;
    return new HistoryError(
      "SW_HISTORY_CORRUPT",
      `Cannot open the SQLite history ${dbFile}: ${(err as Error).message}. Run \`sw history verify\``,
    );
  }

  function open(): Db {
    let db: Db | undefined;
    try {
      db = new DatabaseSync(dbFile);
      db.exec(`PRAGMA busy_timeout = ${busyMs}`);
      migrate(db);
      db.exec("PRAGMA synchronous = NORMAL");
      return db;
    } catch (e) {
      try {
        db?.close();
      } catch {
        // ignore
      }
      throw corrupt(e);
    }
  }

  function userVersion(db: Db): number {
    return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  }

  function migrate(db: Db): void {
    let v = userVersion(db);
    if (v > SQLITE_SCHEMA_VERSION)
      throw new HistoryError(
        "SW_HISTORY_BACKEND",
        `SQLite history ${dbFile} has schema version ${v}, newer than this SECOND WORLD supports (${SQLITE_SCHEMA_VERSION}). Upgrade the tool.`,
      );
    if (v === SQLITE_SCHEMA_VERSION) return;
    if (v === 0) {
      // Only effective before the first table exists; lets prune give freed pages back.
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    }
    const mode = (db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string }).journal_mode;
    if (String(mode).toLowerCase() !== "wal")
      warnOnce(
        "wal",
        `SQLite history ${dbFile}: WAL journal unavailable (${mode}); concurrent readers may wait`,
      );
    transaction(db, () => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
      );
      v = userVersion(db); // another process may have migrated while we waited for the lock
      for (const m of MIGRATIONS) {
        if (m.version <= v) continue;
        db.exec(m.sql);
        db.prepare(
          "INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(m.version, m.name, new Date().toISOString());
        db.exec(`PRAGMA user_version = ${m.version}`);
      }
    });
  }

  // One cached connection per store, closed after IDLE_MS without use (and on error / close()), so
  // consecutive calls of one command share it while no handle outlives a burst of work. fn is
  // synchronous: a connection is never used across an await, so in-process calls cannot interleave.
  let conn: Db | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const statements = new Map<string, ReturnType<Db["prepare"]>>();

  function closeNow(): void {
    if (idle) clearTimeout(idle);
    idle = undefined;
    const c = conn;
    conn = undefined;
    statements.clear();
    try {
      c?.close();
    } catch {
      // already closed
    }
  }

  function withDb<T>(fn: (db: Db) => T): T {
    if (idle) clearTimeout(idle);
    idle = undefined;
    conn ??= open();
    const db = conn;
    try {
      if (importJsonl) importFromJsonl(db);
      return fn(db);
    } catch (e) {
      // Expected outcomes (not found, ambiguous, …) keep the connection; anything else drops it.
      if (!(e instanceof HistoryError)) closeNow();
      throw e;
    } finally {
      if (conn) {
        idle = setTimeout(closeNow, IDLE_MS);
        idle.unref?.();
      }
    }
  }

  /** Prepared-statement cache of the current connection. */
  function prep(db: Db, sql: string): ReturnType<Db["prepare"]> {
    let st = db === conn ? statements.get(sql) : undefined;
    if (!st) {
      st = db.prepare(sql);
      if (db === conn) statements.set(sql, st);
    }
    return st;
  }

  // ---------------------------------------------------------------- JSONL import

  function jsonlSignature(): string | null {
    try {
      const st = statSync(indexFile);
      return `${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {
      return null;
    }
  }

  function getMeta(db: Db, key: string): string | undefined {
    const r = prep(db, "SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  function setMeta(db: Db, key: string, value: string): void {
    prep(db, "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  function readJsonlIndex(): { entries: IndexEntry[]; skipped: number } {
    let text: string;
    try {
      text = readFileSync(indexFile, "utf8");
    } catch {
      return { entries: [], skipped: 0 };
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const byId = new Map<string, IndexEntry>();
    let skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        const e = JSON.parse(line) as unknown;
        if (!isIndexEntry(e)) throw new Error("not an index entry");
        byId.set(e.id, e);
      } catch {
        skipped++;
      }
    }
    return { entries: [...byId.values()].sort(compareEntries), skipped };
  }

  function importFromJsonl(db: Db): void {
    const sig = jsonlSignature();
    if (sig === null || getMeta(db, "jsonl.signature") === sig) return;
    const imported = transaction(db, () => {
      if (getMeta(db, "jsonl.signature") === sig) return 0; // another process imported meanwhile
      const { entries, skipped } = readJsonlIndex();
      const seen = prep(db, "SELECT 1 AS x FROM jsonl_imported WHERE id = ?");
      const exists = prep(db, "SELECT 1 AS x FROM runs WHERE id = ?");
      const mark = prep(db, "INSERT OR IGNORE INTO jsonl_imported (id) VALUES (?)");
      let n = 0;
      for (const e of entries) {
        if (seen.get(e.id)) continue;
        mark.run(e.id);
        if (exists.get(e.id)) continue;
        let report: Buffer | null = null;
        if (!e.compacted) {
          try {
            report = readFileSync(path.join(dir, e.file));
          } catch {
            report = null; // verify reports missing-report, as the JSONL store does
          }
        }
        insertRun(db, e, report, true);
        n++;
      }
      if (n > 0) rebuildMetricNames(db);
      let baselines: Record<string, BaselineRef> = {};
      try {
        baselines = JSON.parse(readFileSync(path.join(dir, "baselines.json"), "utf8")) as Record<
          string,
          BaselineRef
        >;
      } catch {
        baselines = {};
      }
      const addBaseline = prep(db, "INSERT OR IGNORE INTO baselines (name, run_id, set_at) VALUES (?, ?, ?)");
      for (const b of Object.values(isObj(baselines) ? baselines : {}))
        if (isObj(b) && typeof b.name === "string" && typeof b.runId === "string")
          addBaseline.run(b.name, b.runId, typeof b.setAt === "string" ? b.setAt : "");
      setMeta(db, "jsonl.signature", sig);
      setMeta(db, "jsonl.importedAt", new Date().toISOString());
      if (skipped > 0)
        warnOnce(
          "import-skipped",
          `history: ${skipped} unreadable line(s) in ${indexFile} were not imported into ${SQLITE_FILE}`,
        );
      return n;
    });
    if (imported > 0)
      warnOnce(
        "imported",
        `history: imported ${imported} run(s) from the JSONL history (${indexFile}) into ${dbFile}; the JSONL files are left unchanged`,
      );
  }

  // ---------------------------------------------------------------- rows

  /** `bulk`: the caller rebuilds metric_names once at the end (JSONL import). */
  function insertRun(db: Db, e: IndexEntry, report: Uint8Array | null, bulk = false): void {
    const existed = prep(db, "SELECT 1 AS x FROM runs WHERE id = ?").get(e.id) !== undefined;
    if (existed) prep(db, "DELETE FROM run_metrics WHERE run_id = ?").run(e.id);
    prep(
      db,
      `INSERT OR REPLACE INTO runs (id, created_at, label, status, branch, compacted, finding_count, entry, sha256, bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.id,
      e.createdAt,
      e.label ?? null,
      e.status,
      e.git?.branch ?? null,
      e.compacted ? 1 : 0,
      e.findings.count,
      JSON.stringify(e),
      e.sha256 ?? null,
      e.bytes ?? null,
    );
    if (report) prep(db, "INSERT OR REPLACE INTO reports (run_id, report) VALUES (?, ?)").run(e.id, report);
    else if (existed) prep(db, "DELETE FROM reports WHERE run_id = ?").run(e.id);
    const addMetric = prep(
      db,
      "INSERT OR REPLACE INTO run_metrics (name, created_at, run_id, ord, value) VALUES (?, ?, ?, ?, ?)",
    );
    const addName = prep(
      db,
      "INSERT INTO metric_names (name, first) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET first = min(first, excluded.first)",
    );
    let ord = 0;
    for (const [name, value] of Object.entries(e.metrics)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        addMetric.run(name, e.createdAt, e.id, ord, value);
        if (!bulk) addName.run(name, firstKey(e.createdAt, e.id, ord));
      }
      ord++;
    }
    if (existed && !bulk) rebuildMetricNames(db); // the replaced run may have been some name's first appearance
  }

  function rebuildMetricNames(db: Db): void {
    db.exec("DELETE FROM metric_names");
    db.exec(
      `INSERT INTO metric_names (name, first)
       SELECT name, MIN(created_at || char(1) || run_id || char(1) || printf('%08d', ord)) FROM run_metrics GROUP BY name`,
    );
  }

  /** All valid entries, oldest first. Unreadable rows are skipped (with a warning) and listed by verify. */
  function allEntries(db: Db, where = "", params: SqlValue[] = []): IndexEntry[] {
    const rows = prep(db, `SELECT id, entry FROM runs ${where} ORDER BY created_at, id`).all(
      ...params,
    ) as unknown as RunRow[];
    const out: IndexEntry[] = [];
    let bad = 0;
    for (const r of rows) {
      const e = parseEntry(r);
      if (e) out.push(e);
      else bad++;
    }
    if (bad > 0)
      warnOnce(
        `bad-rows:${bad}`,
        `history ${dbFile}: skipped ${bad} unreadable run record(s); run \`sw history verify\` for details`,
      );
    return out;
  }

  /** SQL for the declarative filters (same semantics as `matches()` in store.ts). */
  function filterSql(f: QueryFilter): { where: string; params: SqlValue[] } {
    const c: string[] = [];
    const p: SqlValue[] = [];
    if (f.includeCompacted === false) c.push("runs.compacted = 0");
    if (f.engine) {
      c.push("EXISTS (SELECT 1 FROM json_each(runs.entry, '$.engines') WHERE value = ?)");
      p.push(f.engine);
    }
    if (f.branch) {
      c.push("runs.branch = ?");
      p.push(f.branch);
    }
    if (f.label) {
      c.push("runs.label = ?");
      p.push(f.label);
    }
    if (f.since) {
      c.push("runs.created_at >= ?");
      p.push(f.since);
    }
    if (f.until) {
      c.push("runs.created_at <= ?");
      p.push(f.until);
    }
    if (f.status) {
      c.push("runs.status = ?");
      p.push(f.status);
    }
    if (f.tag) {
      c.push("EXISTS (SELECT 1 FROM json_each(runs.entry, '$.tags') WHERE value = ?)");
      p.push(f.tag);
    }
    if (f.hasFindings !== undefined)
      c.push(f.hasFindings ? "runs.finding_count > 0" : "runs.finding_count = 0");
    if (f.fingerprint) {
      c.push("EXISTS (SELECT 1 FROM json_each(runs.entry, '$.findings.fingerprints') WHERE value = ?)");
      p.push(f.fingerprint);
    }
    return { where: c.length > 0 ? `WHERE ${c.join(" AND ")}` : "", params: p };
  }

  function select(db: Db, f: QueryFilter): IndexEntry[] {
    const { where, params } = filterSql(f);
    const limit =
      f.limit !== undefined && Number.isFinite(f.limit) ? ` LIMIT ${Math.max(0, Math.floor(f.limit))}` : "";
    const rows = prep(
      db,
      `SELECT id, entry FROM runs ${where} ORDER BY created_at DESC, id DESC${limit}`,
    ).all(...params) as unknown as RunRow[];
    const out: IndexEntry[] = [];
    for (const r of rows) {
      const e = parseEntry(r);
      if (e) out.push(e);
    }
    if (out.length < rows.length)
      warnOnce(
        "bad-rows-select",
        `history ${dbFile}: skipped unreadable run record(s); run \`sw history verify\` for details`,
      );
    return out;
  }

  function resolveRow(db: Db, idOrPrefix: string): { entry: IndexEntry; report: Uint8Array | null } {
    if (idOrPrefix.startsWith("baseline:")) {
      const name = idOrPrefix.slice(9);
      const b = prep(db, "SELECT run_id FROM baselines WHERE name = ?").get(name) as
        | { run_id: string }
        | undefined;
      if (!b) throw new HistoryError("SW_HISTORY_NOT_FOUND", `No baseline named "${name}"`);
      idOrPrefix = b.run_id;
    }
    const pick = (r: RunRow | undefined): { entry: IndexEntry; report: Uint8Array | null } | undefined => {
      if (!r) return undefined;
      const entry = parseEntry(r);
      return entry ? { entry, report: r.report ?? null } : undefined;
    };
    const exact = pick(prep(db, RUN_WITH_REPORT).get(idOrPrefix) as RunRow | undefined);
    if (exact) return exact;
    const up = idOrPrefix.toUpperCase();
    if (up.length >= 6) {
      const ids =
        // ids only use [A-Za-z0-9._-], all below "~": an index range scan finds every id with the prefix
        (
          prep(db, "SELECT id, entry FROM runs WHERE id >= ? AND id < ? AND substr(id, 1, ?) = ?").all(
            up,
            `${up}~`,
            up.length,
            up,
          ) as unknown as RunRow[]
        ).filter((r) => parseEntry(r) !== null);
      if (ids.length === 1) {
        const one = pick(prep(db, RUN_WITH_REPORT).get((ids[0] as RunRow).id) as RunRow | undefined);
        if (one) return one;
      }
      if (ids.length > 1)
        throw new HistoryError(
          "SW_HISTORY_AMBIGUOUS",
          `Run id prefix "${idOrPrefix}" matches ${ids.length} runs`,
        );
    }
    throw new HistoryError("SW_HISTORY_NOT_FOUND", `No run "${idOrPrefix}" in ${dir}`);
  }

  async function decodeRun(entry: IndexEntry, report: Uint8Array | null): Promise<HistoryRun> {
    if (entry.compacted) throw compactedError(entry.id);
    const where = `${dbFile} run ${entry.id}`;
    if (!report)
      throw new HistoryError(
        "SW_HISTORY_CORRUPT",
        `Cannot read run ${entry.id} (${where}): the report is missing. Run \`sw history verify\``,
      );
    let run: HistoryRun;
    try {
      const json = JSON.parse((await gunzip(report)).toString("utf8")) as unknown;
      run = migrateRun(json, { id: entry.id, createdAt: entry.createdAt });
    } catch (err) {
      const why = err instanceof UnsupportedSchemaError ? err.message : `${(err as Error).message}`;
      throw new HistoryError(
        "SW_HISTORY_CORRUPT",
        `Cannot read run ${entry.id} (${where}): ${why}. Run \`sw history verify\``,
      );
    }
    if (!isObj(run) || !Array.isArray(run.results) || !run.results.every(isObj))
      throw new HistoryError(
        "SW_HISTORY_CORRUPT",
        `Run ${entry.id} (${where}) is not a SECOND WORLD history run. Run \`sw history verify\``,
      );
    return run;
  }

  async function loadResolved(ids: string[]): Promise<{ entries: IndexEntry[]; runs: HistoryRun[] }> {
    const rows = withDb((db) => ids.map((id) => resolveRow(db, id)));
    const runs = await Promise.all(rows.map((r) => decodeRun(r.entry, r.report)));
    return { entries: rows.map((r) => r.entry), runs };
  }

  function baselineRows(db: Db): BaselineRef[] {
    return (
      prep(db, "SELECT name, run_id, set_at FROM baselines").all() as unknown as {
        name: string;
        run_id: string;
        set_at: string;
      }[]
    ).map((b) => ({ name: b.name, runId: b.run_id, setAt: b.set_at }));
  }

  /**
   * Endpoint metric names that `resolveTrendMetric` may pick for (metric, endpoint), in order of first
   * appearance (oldest run first, then key order within the run) — the order the JSONL store scans.
   */
  function endpointMetricNames(db: Db, metric: string, endpoint: string | undefined): string[] {
    if (!endpoint || metric.includes(".")) return [];
    const prefix = "performance.endpoint.";
    const all = (
      prep(db, "SELECT name FROM metric_names WHERE name >= ? AND name < ? ORDER BY first").all(
        prefix,
        "performance.endpoint/",
      ) as unknown as { name: string }[]
    ).map((r) => r.name);
    const candidates = all.filter((k) => {
      if (!k.endsWith(`.${metric}`) || k.length <= prefix.length + metric.length + 1) return false;
      const key = k.slice(prefix.length, -(metric.length + 1));
      return key === endpoint || key.endsWith(` ${endpoint}`);
    });
    return candidates; // already in order of first appearance
  }

  const store: SqliteHistoryStore = {
    backend: "sqlite",
    dir,

    async close() {
      closeNow();
    },

    async append(input) {
      const id = input.id ?? newId();
      const createdAt = input.createdAt ?? isoNow();
      const git =
        input.git === false
          ? undefined
          : (input.git ?? (opts.captureGit === false ? undefined : await captureGitMetadata(cwd)));
      const { entry, gz } = await prepareRun(input, id, createdAt, git);
      withDb((db) => transaction(db, () => insertRun(db, entry, gz)));
      return entry;
    },

    async get(id) {
      try {
        const [run] = (await loadResolved([id])).runs;
        return run ?? null;
      } catch (e) {
        if (e instanceof HistoryError && e.code !== "SW_HISTORY_AMBIGUOUS") return null;
        throw e;
      }
    },

    async list(o = {}) {
      return withDb((db) => select(db, { includeCompacted: true, ...o }));
    },

    async query(filter) {
      if (typeof filter === "function") return withDb((db) => selectEntries(allEntries(db), filter));
      return withDb((db) => select(db, { includeCompacted: true, ...filter }));
    },

    async setBaseline(name, runId) {
      checkBaselineName(name);
      return withDb((db) =>
        transaction(db, () => {
          const { entry } = resolveRow(db, runId);
          if (entry.compacted)
            throw new HistoryError(
              "SW_HISTORY_COMPACTED",
              `Run ${entry.id} was compacted; cannot be a baseline`,
            );
          const ref: BaselineRef = { name, runId: entry.id, setAt: isoNow() };
          prep(db, "INSERT OR REPLACE INTO baselines (name, run_id, set_at) VALUES (?, ?, ?)").run(
            ref.name,
            ref.runId,
            ref.setAt,
          );
          return ref;
        }),
      );
    },

    async getBaseline(name) {
      const b = withDb(
        (db) =>
          prep(db, "SELECT run_id FROM baselines WHERE name = ?").get(name) as { run_id: string } | undefined,
      );
      return b ? store.get(b.run_id) : null;
    },

    async listBaselines() {
      return withDb(baselineRows).sort((a, b) => a.name.localeCompare(b.name));
    },

    async diff(baseline, current, o = {}) {
      const ids = (x: string | string[]): string[] => (Array.isArray(x) ? x : [x]);
      const A = await loadResolved(ids(baseline));
      const B = await loadResolved(ids(current));
      const oldest = A.entries.map((e) => e.createdAt).sort()[0] ?? "";
      const older = withDb((db) => allEntries(db, "WHERE created_at < ?", [oldest]));
      return diffRuns(A.runs, B.runs, priorFingerprints(older, A.entries), o);
    },

    async trend(metric, filters = {}): Promise<TrendResult> {
      const series = withDb((db) => {
        const name = resolveTrendMetric(
          metric,
          filters.endpoint,
          endpointMetricNames(db, metric, filters.endpoint),
        );
        const { where, params } = filterSql({ includeCompacted: true, ...filters, limit: undefined });
        const lim =
          filters.limit !== undefined && Number.isFinite(filters.limit)
            ? ` LIMIT ${Math.max(0, Math.floor(filters.limit))}`
            : "";
        // newest first + LIMIT in SQL, then back to oldest first (same points as slice(-limit)).
        // Without filters the primary key of run_metrics answers it alone.
        const rows = prep(
          db,
          where
            ? `SELECT m.run_id AS id, m.created_at AS created_at, m.value AS value
               FROM run_metrics m JOIN runs ON runs.id = m.run_id
               ${where} AND m.name = ? ORDER BY m.created_at DESC, m.run_id DESC${lim}`
            : `SELECT run_id AS id, created_at, value FROM run_metrics m
               WHERE m.name = ? ORDER BY m.created_at DESC, m.run_id DESC${lim}`,
        ).all(...params, name) as unknown as { id: string; created_at: string; value: number }[];
        const pts = rows.reverse().map((r) => ({ runId: r.id, createdAt: r.created_at, value: r.value }));
        return { name, pts };
      });
      return trendAnalysis(series.name, series.pts, filters);
    },

    async verify(): Promise<VerifyReport> {
      const errors: VerifyIssue[] = [];
      const warnings: VerifyIssue[] = [];
      let rows: { id: string; entry: string; report: Uint8Array | null }[] = [];
      let baselines: BaselineRef[] = [];
      try {
        withDb((db) => {
          const ck = prep(db, "PRAGMA quick_check").all() as unknown as Record<string, string>[];
          const msgs = ck.map((r) => String(Object.values(r)[0])).filter((m) => m !== "ok");
          for (const m of msgs.slice(0, 20))
            errors.push({ file: SQLITE_FILE, problem: "db-integrity", detail: m });
          rows = prep(
            db,
            `SELECT runs.id AS id, runs.entry AS entry, reports.report AS report FROM runs
             LEFT JOIN reports ON reports.run_id = runs.id ORDER BY runs.created_at, runs.id`,
          ).all() as unknown as typeof rows;
          baselines = baselineRows(db);
        });
      } catch (e) {
        errors.push({ file: SQLITE_FILE, problem: "db-integrity", detail: (e as Error).message });
        return { ok: false, checked: 0, errors, warnings, backend: "sqlite" };
      }
      const ids = new Set<string>();
      let checked = 0;
      for (const r of rows) {
        const e = parseEntry(r);
        if (!e) {
          errors.push({ id: r.id, problem: "corrupt-index-line", detail: String(r.entry).slice(0, 120) });
          continue;
        }
        checked++;
        ids.add(e.id);
        if (e.compacted) continue;
        const where = `${SQLITE_FILE}#${e.id}`;
        if (!r.report) {
          errors.push({ id: e.id, file: where, problem: "missing-report" });
          continue;
        }
        const actual = sha256(r.report);
        if (actual !== e.sha256) {
          errors.push({
            id: e.id,
            file: where,
            problem: "checksum-mismatch",
            detail: `expected ${String(e.sha256).slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
          });
          continue;
        }
        try {
          const run = migrateRun(JSON.parse((await gunzip(r.report)).toString("utf8")), {
            id: e.id,
            createdAt: e.createdAt,
          });
          if (run.id !== e.id) errors.push({ id: e.id, file: where, problem: "id-mismatch", detail: run.id });
        } catch (err) {
          errors.push({
            id: e.id,
            file: where,
            problem: "unreadable-report",
            detail: (err as Error).message,
          });
        }
      }
      for (const b of baselines)
        if (!ids.has(b.runId)) errors.push({ id: b.runId, problem: "baseline-missing-run", detail: b.name });
      return { ok: errors.length === 0, checked, errors, warnings, backend: "sqlite" };
    },

    async prune(o = {}) {
      const dryRun = o.dryRun ?? false;
      return withDb((db) => {
        const run = () => {
          const entries = allEntries(db);
          const baselineIds = new Set(baselineRows(db).map((b) => b.runId));
          const plan = planPrune(entries, baselineIds, o);
          if (!dryRun) {
            const byId = new Map(entries.map((e) => [e.id, e]));
            const compact = prep(db, "UPDATE runs SET compacted = 1, entry = ? WHERE id = ?");
            const dropReport = prep(db, "DELETE FROM reports WHERE run_id = ?");
            for (const id of plan.compacted) {
              const e = byId.get(id) as IndexEntry;
              compact.run(JSON.stringify({ ...e, compacted: true }), id);
              dropReport.run(id);
            }
            const delRun = prep(db, "DELETE FROM runs WHERE id = ?");
            const delMetrics = prep(db, "DELETE FROM run_metrics WHERE run_id = ?");
            for (const id of plan.removed) {
              delRun.run(id);
              delMetrics.run(id);
              dropReport.run(id);
            }
            if (plan.removed.length > 0) rebuildMetricNames(db);
          }
          return { kept: plan.keep.size, compacted: plan.compacted, removed: plan.removed, dryRun };
        };
        const r = dryRun ? run() : transaction(db, run);
        if (!dryRun && (r.compacted.length > 0 || r.removed.length > 0)) db.exec("PRAGMA incremental_vacuum");
        return r;
      });
    },
  };
  // Open once eagerly: surfaces "not a database" / newer-schema errors early and runs the import.
  withDb(() => undefined);
  return store;
}

/**
 * Going back to JSONL: writes the runs and baselines of `<dir>/history.db` that the JSONL index does
 * not have yet into the JSONL layout of the same directory (report bytes verbatim, sha256 unchanged).
 * Idempotent. Compacted runs are written as compacted summaries.
 */
export async function exportSqliteHistoryToJsonl(
  opts: { cwd?: string; dir?: string; loadSqlite?: () => Promise<SqliteModule | null> } = {},
): Promise<{ exported: number; baselines: number }> {
  const sqlite = await (opts.loadSqlite ?? loadNodeSqlite)();
  if (!sqlite) throw new SqliteUnavailableError(nodeSqliteUnavailableReason() ?? "module not found");
  const dir = opts.dir ?? path.join(opts.cwd ?? process.cwd(), ".second-world", "history");
  const db = new sqlite.DatabaseSync(path.join(dir, SQLITE_FILE), { readOnly: true });
  let rows: { id: string; entry: string; report: Uint8Array | null }[];
  let bl: { name: string; run_id: string; set_at: string }[];
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    rows = db
      .prepare(
        `SELECT runs.id AS id, runs.entry AS entry, reports.report AS report FROM runs
         LEFT JOIN reports ON reports.run_id = runs.id ORDER BY runs.created_at, runs.id`,
      )
      .all() as unknown as typeof rows;
    bl = db.prepare("SELECT name, run_id, set_at FROM baselines").all() as unknown as typeof bl;
  } finally {
    db.close();
  }
  const indexFile = path.join(dir, "runs.jsonl");
  const have = new Set<string>();
  try {
    for (const line of (await readFile(indexFile, "utf8")).split(/\r?\n/)) {
      try {
        const e = JSON.parse(line) as unknown;
        if (isIndexEntry(e)) have.add(e.id);
      } catch {
        // torn line
      }
    }
  } catch {
    // no JSONL index yet
  }
  let exported = 0;
  for (const r of rows) {
    const e = parseEntry(r);
    if (!e || have.has(e.id)) continue;
    if (!e.compacted && r.report) await atomicWrite(path.join(dir, e.file), r.report);
    await appendLine(indexFile, JSON.stringify(e));
    exported++;
  }
  const baselinesFile = path.join(dir, "baselines.json");
  let current: Record<string, BaselineRef> = {};
  try {
    current = JSON.parse(await readFile(baselinesFile, "utf8")) as Record<string, BaselineRef>;
  } catch {
    current = {};
  }
  let added = 0;
  for (const b of bl)
    if (!current[b.name]) {
      current[b.name] = { name: b.name, runId: b.run_id, setAt: b.set_at };
      added++;
    }
  if (added > 0) await atomicWrite(baselinesFile, `${JSON.stringify(current, null, 2)}\n`);
  return { exported, baselines: added };
}
