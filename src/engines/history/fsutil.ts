/**
 * Crash-safe file primitives for the history store.
 * See docs/04-data-structures-and-algorithms.md §9.5 (append-only log + atomic writes) and
 * docs/06-environments-and-portability.md §2 (Windows rename-over-existing: retry on EPERM/EBUSY).
 */
import { randomBytes } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function code(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

/** rename() with bounded retry on transient Windows errors (antivirus, indexers holding the file). */
export async function renameWithRetry(from: string, to: string, attempts = 10): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      if (!RETRY_CODES.has(code(e) ?? "") || i >= attempts - 1) throw e;
      await delay(Math.min(500, 10 * 2 ** i));
    }
  }
}

export const TMP_MARKER = ".tmp-";

/**
 * Atomic write: write `<file>.tmp-<pid>-<rand>`, fsync, close, rename over the target.
 * Readers see either the old or the new content, never a partial file. A crash leaves at most a
 * `.tmp-` file that readers ignore.
 */
export async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}${TMP_MARKER}${process.pid}-${randomBytes(4).toString("hex")}`;
  let fh: FileHandle | undefined;
  try {
    fh = await open(tmp, "wx");
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = undefined;
    await renameWithRetry(tmp, file);
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/** Appends one line durably (open O_APPEND, write, fsync). Single small writes are atomic on POSIX. */
export async function appendLine(file: string, line: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const fh = await open(file, "a+");
  try {
    // After a crash mid-append the file may end in a partial line: start on a fresh line so the
    // new record stays parseable (the partial one is reported by verify()).
    const { size } = await fh.stat();
    let prefix = "";
    if (size > 0) {
      const b = Buffer.alloc(1);
      await fh.read(b, 0, 1, size - 1);
      if (b[0] !== 0x0a) prefix = "\n";
    }
    await fh.write(`${prefix}${line}${line.endsWith("\n") ? "" : "\n"}`);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export interface LockOptions {
  /** Give up after this long (ms). Default 10 s. */
  timeoutMs?: number;
  /** A lock older than this is stale (ms). Default 60 s. */
  staleMs?: number;
  /** Wall clock (ms since epoch) — lock staleness spans processes, so wall time is required. */
  now?: () => number;
  /** Poll interval (ms). Default 25. */
  pollMs?: number;
}

export interface LockInfo {
  pid: number;
  host: string;
  at: number;
  token: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return code(e) === "EPERM"; // exists but not ours
  }
}

/** Whether an existing lock file is stale: unreadable/corrupt, too old, or held by a dead local process. */
export function isStale(info: LockInfo | null, now: number, staleMs: number): boolean {
  if (!info) return true;
  if (now - info.at > staleMs) return true;
  if (info.host === hostname() && info.pid !== process.pid && !pidAlive(info.pid)) return true;
  return false;
}

async function readLock(file: string): Promise<LockInfo | null> {
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as LockInfo;
    return typeof j.pid === "number" && typeof j.at === "number" ? j : null;
  } catch {
    return null;
  }
}

async function unreadableLockIsStale(file: string, staleMs: number): Promise<boolean> {
  try {
    const st = await stat(file);
    return Date.now() - st.mtimeMs > staleMs;
  } catch {
    return true; // vanished: retry immediately
  }
}

export class LockTimeoutError extends Error {
  constructor(
    readonly file: string,
    readonly holder: LockInfo | null,
  ) {
    super(
      `Timed out waiting for history lock ${file}${holder ? ` (held by pid ${holder.pid} on ${holder.host})` : ""}`,
    );
    this.name = "LockTimeoutError";
  }
}

/**
 * Acquires an exclusive lock file via O_EXCL ("wx"). Stale locks are broken. Returns a release function.
 * In-process callers are additionally serialised through a promise chain per lock path.
 */
export async function acquireLock(file: string, opts: LockOptions = {}): Promise<() => Promise<void>> {
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  const pollMs = opts.pollMs ?? 25;
  await mkdir(path.dirname(file), { recursive: true });
  const token = randomBytes(8).toString("hex");
  const deadline = now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(file, "wx");
      try {
        const info: LockInfo = { pid: process.pid, host: hostname(), at: now(), token };
        await fh.writeFile(JSON.stringify(info));
        await fh.sync();
      } finally {
        await fh.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const cur = await readLock(file);
        if (cur && cur.token !== token) return; // someone broke our (stale) lock; not ours to delete
        await unlink(file).catch(() => {});
      };
    } catch (e) {
      if (code(e) !== "EEXIST" && !RETRY_CODES.has(code(e) ?? "")) throw e;
    }
    const holder = await readLock(file);
    // An unreadable lock may be mid-creation by its holder: judge it by mtime instead.
    const stale = holder ? isStale(holder, now(), staleMs) : await unreadableLockIsStale(file, staleMs);
    if (stale) {
      // Break the stale lock by renaming it away first (atomic), so two breakers cannot both win.
      const grave = `${file}.stale-${randomBytes(4).toString("hex")}`;
      try {
        await rename(file, grave);
        await unlink(grave).catch(() => {});
      } catch {
        // someone else broke or released it
      }
      continue;
    }
    if (now() >= deadline) throw new LockTimeoutError(file, holder);
    await delay(Math.min(pollMs * (1 + Math.min(attempt, 8) / 2), 200));
  }
}

/** Runs fn while holding the lock. */
export async function withLock<T>(file: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T> {
  const release = await acquireLock(file, opts);
  try {
    return await fn();
  } finally {
    await release();
  }
}
