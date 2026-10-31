/**
 * JSONL history backend (default). See docs/03-engines/evidence-and-history.md §B.1–§B.3 and
 * docs/04-data-structures-and-algorithms.md §9.5.
 *
 * Layout under `dir` (default `<cwd>/.second-world/history`):
 *   runs.jsonl            index, one JSON line per run (append-only; rewritten atomically only by prune)
 *   runs/<ulid>.json.gz   full immutable report (gzip), sha256 recorded in the index
 *   baselines.json        { name → { runId, setAt } } (small, atomically replaced)
 *   .lock                 O_EXCL writer lock with stale-lock detection
 * Readers tolerate a truncated/corrupt index line (crash mid-append) and ignore `.tmp-` files.
 */
import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import { sha256 } from "../../shared/util/hash.js";
import { ulid } from "../../shared/util/ulid.js";
import { type CompareRunsOptions, compareRuns, type TrendOptions, trendAnalysis } from "./compare.js";
import { appendLine, atomicWrite, type LockOptions, TMP_MARKER, withLock } from "./fsutil.js";
import { captureGitMetadata } from "./git.js";
import { extractMetrics, maxSeverity, overallStatus } from "./metrics.js";
import { migrateRun } from "./migrations.js";
import {
  type AppendRunInput,
  type BaselineRef,
  HISTORY_SCHEMA_VERSION,
  type HistoryRun,
  type IndexEntry,
  type ListOptions,
  type PruneOptions,
  type PruneReport,
  type QueryFilter,
  type RunComparison,
  type TrendResult,
  type VerifyIssue,
  type VerifyReport,
} from "./types.js";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

export interface HistoryStore {
  readonly backend: "jsonl" | "sqlite";
  readonly dir: string;
  append(input: AppendRunInput): Promise<IndexEntry>;
  /** Full run by id (or unique id prefix ≥ 6 chars); null when unknown or compacted. */
  get(id: string): Promise<HistoryRun | null>;
  /** Index entries, newest first. */
  list(opts?: ListOptions): Promise<IndexEntry[]>;
  query(filter: QueryFilter | ((e: IndexEntry) => boolean)): Promise<IndexEntry[]>;
  setBaseline(name: string, runId: string): Promise<BaselineRef>;
  getBaseline(name: string): Promise<HistoryRun | null>;
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

export interface JsonlStoreOptions {
  /** Project root; used for the default dir and git capture. Default process.cwd(). */
  cwd?: string;
  /** History directory. Default `<cwd>/.second-world/history`. */
  dir?: string;
  lock?: LockOptions;
  newId?: () => string;
  isoNow?: () => string;
  /** Capture git metadata on append when not given. Default true. */
  captureGit?: boolean;
  /**
   * Called (once per distinct problem per store instance) when a read skips unreadable index lines,
   * e.g. a record cut short by a crash mid-append. Reads never fail because of such lines.
   */
  onWarning?: (message: string) => void;
}

export class HistoryError extends Error {
  constructor(
    readonly code: "SW_HISTORY_NOT_FOUND" | "SW_HISTORY_AMBIGUOUS" | "SW_HISTORY_COMPACTED",
    message: string,
  ) {
    super(message);
    this.name = "HistoryError";
  }
}

const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

export function createJsonlStore(opts: JsonlStoreOptions = {}): HistoryStore {
  const cwd = opts.cwd ?? process.cwd();
  const dir = opts.dir ?? path.join(cwd, ".second-world", "history");
  const indexFile = path.join(dir, "runs.jsonl");
  const runsDir = path.join(dir, "runs");
  const baselinesFile = path.join(dir, "baselines.json");
  const lockFile = path.join(dir, ".lock");
  const newId = opts.newId ?? (() => ulid());
  const isoNow = opts.isoNow ?? (() => new Date().toISOString());
  const locked = <T>(fn: () => Promise<T>): Promise<T> => withLock(lockFile, fn, opts.lock);

  interface IndexRead {
    entries: IndexEntry[];
    corrupt: { line: number; text: string }[];
  }

  async function readIndex(): Promise<IndexRead> {
    let text: string;
    try {
      text = await readFile(indexFile, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], corrupt: [] };
      throw e;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const byId = new Map<string, IndexEntry>();
    const corrupt: IndexRead["corrupt"] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.trim() === "") continue;
      try {
        const e = JSON.parse(line) as IndexEntry;
        if (typeof e.id !== "string" || typeof e.file !== "string") throw new Error("not an index entry");
        byId.set(e.id, e); // last wins
      } catch {
        corrupt.push({ line: i + 1, text: line.slice(0, 120) });
      }
    }
    if (corrupt.length > 0 && opts.onWarning) warnCorrupt(corrupt, text.endsWith("\n"));
    const entries = [...byId.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
    );
    return { entries, corrupt };
  }

  const warned = new Set<string>();
  function warnCorrupt(corrupt: IndexRead["corrupt"], endsWithNewline: boolean): void {
    const fresh = corrupt.filter((c) => !warned.has(`${c.line}:${c.text}`));
    if (fresh.length === 0) return;
    for (const c of fresh) warned.add(`${c.line}:${c.text}`);
    const last = corrupt[corrupt.length - 1] as IndexRead["corrupt"][number];
    const trailing = !endsWithNewline && fresh.includes(last);
    opts.onWarning?.(
      `history index ${indexFile}: skipped ${fresh.length} unreadable line(s) (line ${fresh.map((c) => c.line).join(", ")})` +
        (trailing ? "; the last record is incomplete (interrupted write)" : "") +
        "; run `sw history verify` for details",
    );
  }

  async function readBaselines(): Promise<Record<string, BaselineRef>> {
    try {
      return JSON.parse(await readFile(baselinesFile, "utf8")) as Record<string, BaselineRef>;
    } catch {
      return {};
    }
  }

  async function resolveEntry(idOrPrefix: string): Promise<IndexEntry> {
    const { entries } = await readIndex();
    if (idOrPrefix.startsWith("baseline:")) {
      const name = idOrPrefix.slice(9);
      const b = (await readBaselines())[name];
      if (!b) throw new HistoryError("SW_HISTORY_NOT_FOUND", `No baseline named "${name}"`);
      idOrPrefix = b.runId;
    }
    const exact = entries.find((e) => e.id === idOrPrefix);
    if (exact) return exact;
    const up = idOrPrefix.toUpperCase();
    const matches = up.length >= 6 ? entries.filter((e) => e.id.startsWith(up)) : [];
    if (matches.length === 1) return matches[0] as IndexEntry;
    if (matches.length > 1)
      throw new HistoryError(
        "SW_HISTORY_AMBIGUOUS",
        `Run id prefix "${idOrPrefix}" matches ${matches.length} runs`,
      );
    throw new HistoryError("SW_HISTORY_NOT_FOUND", `No run "${idOrPrefix}" in ${dir}`);
  }

  async function loadRun(e: IndexEntry): Promise<HistoryRun> {
    if (e.compacted)
      throw new HistoryError(
        "SW_HISTORY_COMPACTED",
        `Run ${e.id} was compacted by retention; only its summary remains`,
      );
    const buf = await readFile(path.join(dir, e.file));
    const json = JSON.parse((await gunzip(buf)).toString("utf8")) as unknown;
    return migrateRun(json, { id: e.id, createdAt: e.createdAt });
  }

  function matches(e: IndexEntry, f: QueryFilter): boolean {
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

  const store: HistoryStore = {
    backend: "jsonl",
    dir,

    async append(input) {
      const id = input.id ?? newId();
      const createdAt = input.createdAt ?? isoNow();
      const git =
        input.git === false
          ? undefined
          : (input.git ?? (opts.captureGit === false ? undefined : await captureGitMetadata(cwd)));
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
      await locked(async () => {
        await atomicWrite(path.join(runsDir, `${id}.json.gz`), gz);
        await appendLine(indexFile, JSON.stringify(entry));
      });
      return entry;
    },

    async get(id) {
      try {
        return await loadRun(await resolveEntry(id));
      } catch (e) {
        if (e instanceof HistoryError && e.code !== "SW_HISTORY_AMBIGUOUS") return null;
        throw e;
      }
    },

    async list(o = {}) {
      const { entries } = await readIndex();
      const f: QueryFilter = { includeCompacted: true, ...o };
      const out = entries.filter((e) => matches(e, f)).reverse();
      return o.limit !== undefined ? out.slice(0, o.limit) : out;
    },

    async query(filter) {
      const { entries } = await readIndex();
      const out =
        typeof filter === "function"
          ? entries.filter(filter)
          : entries.filter((e) => matches(e, { includeCompacted: true, ...filter }));
      const lim = typeof filter === "function" ? undefined : filter.limit;
      const newest = out.reverse();
      return lim !== undefined ? newest.slice(0, lim) : newest;
    },

    async setBaseline(name, runId) {
      if (!/^[A-Za-z0-9._\-/]{1,100}$/.test(name)) throw new Error(`Invalid baseline name "${name}"`);
      const e = await resolveEntry(runId);
      if (e.compacted)
        throw new HistoryError("SW_HISTORY_COMPACTED", `Run ${e.id} was compacted; cannot be a baseline`);
      const ref: BaselineRef = { name, runId: e.id, setAt: isoNow() };
      await locked(async () => {
        const all = await readBaselines();
        all[name] = ref;
        await atomicWrite(baselinesFile, `${JSON.stringify(all, null, 2)}\n`);
      });
      return ref;
    },

    async getBaseline(name) {
      const b = (await readBaselines())[name];
      return b ? store.get(b.runId) : null;
    },

    async listBaselines() {
      return Object.values(await readBaselines()).sort((a, b) => a.name.localeCompare(b.name));
    },

    async diff(baseline, current, o = {}) {
      const ids = (x: string | string[]): string[] => (Array.isArray(x) ? x : [x]);
      const baseEntries = await Promise.all(ids(baseline).map(resolveEntry));
      const curEntries = await Promise.all(ids(current).map(resolveEntry));
      const A = await Promise.all(baseEntries.map(loadRun));
      const B = await Promise.all(curEntries.map(loadRun));
      // Fingerprints seen in runs older than the oldest baseline run → "regressed" classification.
      const oldest = baseEntries.map((e) => e.createdAt).sort()[0] ?? "";
      const { entries } = await readIndex();
      const prior = new Set<string>();
      for (const e of entries)
        if (e.createdAt < oldest) for (const fp of e.findings.fingerprints) prior.add(fp);
      return compareRuns(A, B, { ...o, priorFingerprints: o.priorFingerprints ?? prior });
    },

    async trend(metric, filters = {}) {
      const { entries } = await readIndex();
      const f: QueryFilter = { includeCompacted: true, ...filters };
      let name = metric;
      if (filters.endpoint && !metric.includes(".")) {
        const ep = filters.endpoint;
        const keys = new Set<string>();
        for (const e of entries)
          for (const k of Object.keys(e.metrics))
            if (k.startsWith("performance.endpoint.") && k.endsWith(`.${metric}`)) {
              const key = k.slice("performance.endpoint.".length, -(metric.length + 1));
              if (key === ep || key.endsWith(` ${ep}`)) keys.add(k);
            }
        name = [...keys][0] ?? `performance.endpoint.${ep}.${metric}`;
      } else if (!metric.includes(".")) name = `performance.http.${metric}`;
      let series = entries
        .filter((e) => matches(e, f) && typeof e.metrics[name] === "number")
        .map((e) => ({ runId: e.id, createdAt: e.createdAt, value: e.metrics[name] as number }));
      if (filters.limit !== undefined) series = series.slice(-filters.limit);
      return trendAnalysis(name, series, filters);
    },

    async verify() {
      const errors: VerifyIssue[] = [];
      const warnings: VerifyIssue[] = [];
      const { entries, corrupt } = await readIndex();
      for (const c of corrupt) errors.push({ line: c.line, problem: "corrupt-index-line", detail: c.text });
      const known = new Set<string>();
      for (const e of entries) {
        known.add(path.posix.basename(e.file));
        if (e.compacted) continue;
        let buf: Buffer;
        try {
          buf = await readFile(path.join(dir, e.file));
        } catch {
          errors.push({ id: e.id, file: e.file, problem: "missing-report" });
          continue;
        }
        if (sha256(buf) !== e.sha256) {
          errors.push({
            id: e.id,
            file: e.file,
            problem: "checksum-mismatch",
            detail: `expected ${e.sha256.slice(0, 12)}…, got ${sha256(buf).slice(0, 12)}…`,
          });
          continue;
        }
        try {
          const run = migrateRun(JSON.parse((await gunzip(buf)).toString("utf8")), {
            id: e.id,
            createdAt: e.createdAt,
          });
          if (run.id !== e.id)
            errors.push({ id: e.id, file: e.file, problem: "id-mismatch", detail: run.id });
        } catch (err) {
          errors.push({
            id: e.id,
            file: e.file,
            problem: "unreadable-report",
            detail: (err as Error).message,
          });
        }
      }
      let files: string[] = [];
      try {
        files = await readdir(runsDir);
      } catch {
        // no runs yet
      }
      for (const f of files) {
        if (f.includes(TMP_MARKER)) warnings.push({ file: `runs/${f}`, problem: "leftover-temp" });
        else if (f.endsWith(".json.gz") && !known.has(f))
          warnings.push({ file: `runs/${f}`, problem: "orphan-report" });
      }
      const ids = new Set(entries.map((e) => e.id));
      for (const b of Object.values(await readBaselines()))
        if (!ids.has(b.runId)) errors.push({ id: b.runId, problem: "baseline-missing-run", detail: b.name });
      return { ok: errors.length === 0, checked: entries.length, errors, warnings };
    },

    async prune(o = {}) {
      const keepLast = o.keepLast ?? 50;
      const compact = o.compact ?? true;
      const dryRun = o.dryRun ?? false;
      return locked(async () => {
        const { entries } = await readIndex();
        const baselineIds = new Set(Object.values(await readBaselines()).map((b) => b.runId));
        const newestFirst = [...entries].reverse();
        const keep = new Set<string>();
        for (const e of newestFirst.slice(0, keepLast)) keep.add(e.id);
        for (const e of entries) if (baselineIds.has(e.id) || e.findings.count > 0) keep.add(e.id);
        const compacted: string[] = [];
        const removed: string[] = [];
        const next: IndexEntry[] = [];
        for (const e of entries) {
          if (keep.has(e.id)) next.push(e);
          else if (compact) {
            if (!e.compacted) compacted.push(e.id);
            next.push({ ...e, compacted: true });
          } else removed.push(e.id);
        }
        if (!dryRun && (compacted.length > 0 || removed.length > 0)) {
          await atomicWrite(
            indexFile,
            next.map((e) => JSON.stringify(e)).join("\n") + (next.length ? "\n" : ""),
          );
          for (const id of [...compacted, ...removed])
            await unlink(path.join(runsDir, `${id}.json.gz`)).catch(() => {});
        }
        if (!dryRun) {
          // Clean leftover temp files from crashed writers (safe: we hold the lock).
          try {
            for (const f of await readdir(runsDir))
              if (f.includes(TMP_MARKER)) await unlink(path.join(runsDir, f)).catch(() => {});
          } catch {
            // no runs dir
          }
          // ...and lock-creation temps (`.lock.tmp-*`) of writers killed while taking the lock.
          try {
            for (const f of await readdir(dir))
              if (f.startsWith(`.lock${TMP_MARKER}`)) await unlink(path.join(dir, f)).catch(() => {});
          } catch {
            // no dir
          }
        }
        return { kept: keep.size, compacted, removed, dryRun };
      });
    },
  };
  return store;
}
