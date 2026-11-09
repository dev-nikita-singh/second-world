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
import { gunzip as gunzipCb } from "node:zlib";
import { sha256 } from "../../shared/util/hash.js";
import { ulid } from "../../shared/util/ulid.js";
import {
  appendLine,
  atomicWrite,
  clearAbandonedBreaker,
  type LockOptions,
  TMP_MARKER,
  withLock,
} from "./fsutil.js";
import { captureGitMetadata } from "./git.js";
import { migrateRun, UnsupportedSchemaError } from "./migrations.js";
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
  resolveIn,
  selectEntries,
  trendOver,
} from "./store.js";
import type { BaselineRef, HistoryRun, IndexEntry, VerifyIssue } from "./types.js";

export { HistoryError, type HistoryStore, isIndexEntry } from "./store.js";

const gunzip = promisify(gunzipCb);

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

  async function readIndex(retried = false): Promise<IndexRead> {
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
        if (!isIndexEntry(e)) throw new Error("not an index entry");
        byId.set(e.id, e); // last wins
      } catch {
        corrupt.push({ line: i + 1, text: line.slice(0, 120) });
      }
    }
    // Only the last line is unreadable and has no newline: either a crashed writer (it stays like this) or
    // another process appending right now (one write() per record, which a reader on Linux/macOS can see
    // mid-write). Re-read once after a moment before calling it an interrupted write.
    if (!retried && corrupt.length === 1 && !text.endsWith("\n") && corrupt[0]?.line === lines.length) {
      await new Promise((r) => setTimeout(r, 50));
      return readIndex(true);
    }
    if (corrupt.length > 0 && opts.onWarning) warnCorrupt(corrupt, text.endsWith("\n"));
    const entries = [...byId.values()].sort(compareEntries);
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
    return resolveIn(entries, idOrPrefix, dir);
  }

  async function loadRun(e: IndexEntry): Promise<HistoryRun> {
    if (e.compacted) throw compactedError(e.id);
    const file = path.join(dir, e.file);
    let run: HistoryRun;
    try {
      const json = JSON.parse((await gunzip(await readFile(file))).toString("utf8")) as unknown;
      run = migrateRun(json, { id: e.id, createdAt: e.createdAt });
    } catch (err) {
      // missing, not gzip, not JSON, or a newer schema: a user-facing problem, not an internal error
      const why = err instanceof UnsupportedSchemaError ? err.message : `${(err as Error).message}`;
      throw new HistoryError(
        "SW_HISTORY_CORRUPT",
        `Cannot read run ${e.id} (${file}): ${why}. Run \`sw history verify\``,
      );
    }
    if (!isObj(run) || !Array.isArray(run.results) || !run.results.every(isObj))
      throw new HistoryError(
        "SW_HISTORY_CORRUPT",
        `Run ${e.id} (${file}) is not a SECOND WORLD history run. Run \`sw history verify\``,
      );
    return run;
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
      const { entry, gz } = await prepareRun(input, id, createdAt, git);
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
      return selectEntries((await readIndex()).entries, o);
    },

    async query(filter) {
      return selectEntries((await readIndex()).entries, filter);
    },

    async setBaseline(name, runId) {
      checkBaselineName(name);
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
      const { entries } = await readIndex();
      return diffRuns(A, B, priorFingerprints(entries, baseEntries), o);
    },

    async trend(metric, filters = {}) {
      return trendOver((await readIndex()).entries, metric, filters);
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
      return { ok: errors.length === 0, checked: entries.length, errors, warnings, backend: "jsonl" };
    },

    async prune(o = {}) {
      const dryRun = o.dryRun ?? false;
      return locked(async () => {
        const { entries } = await readIndex();
        const baselineIds = new Set(Object.values(await readBaselines()).map((b) => b.runId));
        const { keep, compacted, removed } = planPrune(entries, baselineIds, o);
        const gone = new Set(removed);
        const next: IndexEntry[] = [];
        for (const e of entries) {
          if (gone.has(e.id)) continue;
          next.push(keep.has(e.id) || e.compacted ? e : { ...e, compacted: true });
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
          // ...and the `.lock.break` of a writer SIGKILLed while breaking a stale lock.
          await clearAbandonedBreaker(lockFile);
        }
        return { kept: keep.size, compacted, removed, dryRun };
      });
    },
  };
  return store;
}
