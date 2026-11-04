/**
 * Crash-safe file primitives for the history store.
 * See docs/04-data-structures-and-algorithms.md §9.5 (append-only log + atomic writes) and
 * docs/06-environments-and-portability.md §2 (Windows rename-over-existing: retry on EPERM/EBUSY).
 */
import { randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { type FileHandle, link, mkdir, open, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { createTempSync, releaseTemp } from "../../shared/util/fs-temp.js";

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
 * `.tmp-` file that readers ignore. The temp is created on the main thread and registered
 * (src/shared/util/fs-temp.ts), then reopened without O_CREAT, so a hard exit removes it reliably.
 */
export async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}${TMP_MARKER}${process.pid}-${randomBytes(4).toString("hex")}`;
  createTempSync(tmp);
  let fh: FileHandle | undefined;
  try {
    fh = await open(tmp, "r+");
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = undefined;
    await renameWithRetry(tmp, file);
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw e;
  } finally {
    releaseTemp(tmp);
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
  /** The holder refreshes the lock's mtime this often (ms). Default 1 s. */
  heartbeatMs?: number;
  /**
   * A lock of this host whose mtime is older than this (ms) is stale even when its pid is alive: the
   * pid may have been reused by an unrelated process (Windows reuses pids quickly). Default 5 s.
   */
  heartbeatStaleMs?: number;
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

/**
 * Heartbeat check (same host only: the holder stamps mtime with its clock, the waiter compares with
 * its own). A holder dead for longer than `heartbeatStaleMs` whose pid was reused looks alive to
 * pidAlive(); its stopped heartbeat gives it away (tests/unit/robust/pid-reuse.test.ts).
 */
async function heartbeatStopped(file: string, info: LockInfo, heartbeatStaleMs: number): Promise<boolean> {
  if (info.host !== hostname()) return false;
  try {
    return Date.now() - (await stat(file)).mtimeMs > heartbeatStaleMs;
  } catch {
    return false; // vanished: the next create attempt sees it
  }
}

async function readLock(file: string): Promise<LockInfo | null> {
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as LockInfo;
    return typeof j.pid === "number" && typeof j.at === "number" ? j : null;
  } catch {
    return null;
  }
}

/**
 * Locks are created with their content (createLockFile), so a lock that is still empty/garbled after
 * this long was left by a writer that died inside the O_EXCL fallback, or by an older version.
 */
const UNREADABLE_GRACE_MS = 2_000;

async function unreadableLockIsStale(file: string, staleMs: number): Promise<boolean> {
  try {
    const st = await stat(file);
    return Date.now() - st.mtimeMs > staleMs;
  } catch {
    return true; // vanished: retry immediately
  }
}

/**
 * Creates the lock file with its content in one step: write a private temp file, then hard-link it to
 * the lock path (link fails with EEXIST when the lock exists, like O_EXCL). A holder killed between
 * `open("wx")` and its write used to leave an EMPTY lock that every waiter could only judge by mtime
 * (60 s) — longer than their 10 s timeout, so history saves failed for a minute after such a crash
 * (tests/integration/concurrency/cli-parallel.test.ts "history writer killed mid-write").
 * When link fails for another reason (no hard links on FAT/some shares) it falls back to O_EXCL + write. Returns false when the lock is held.
 */
async function createLockFile(file: string, info: LockInfo): Promise<boolean> {
  const tmp = `${file}${TMP_MARKER}${process.pid}-${info.token}`;
  // Main-thread creation + registration: a hard exit removes the temp (src/shared/util/fs-temp.ts); a
  // link still queued on the thread pool then fails with ENOENT instead of creating the lock late.
  createTempSync(tmp, JSON.stringify(info));
  try {
    await link(tmp, file);
    return true;
  } catch (e) {
    if (code(e) === "EEXIST") return false;
    // no hard links here (FAT, some network shares) or a transient refusal: O_EXCL is still correct
  } finally {
    await unlink(tmp).catch(() => {});
    releaseTemp(tmp);
  }
  // O_EXCL fallback, synchronous for the same reason: the lock exists with its content before any
  // signal handler can run (the hard-exit path removes a lock whose owner record is ours).
  let fd: number;
  try {
    fd = openSync(file, "wx");
  } catch (e) {
    if (code(e) === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Like unreadableLockIsStale, but a vanished lock is not "old" (there is nothing to remove). */
async function unreadableLockIsOld(file: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(file)).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/** A `.break` file older than this was left by a breaker that died inside its few-ms critical section. */
const BREAK_STALE_MS = 5_000;

/**
 * Removes a stale lock without ever removing a live one. Waiters that judged the same lock stale are
 * serialised through `<lock>.break` (O_EXCL) and re-check staleness under it: the first removes the
 * stale lock, a later one finds the fresh lock of whoever won the next `wx` open and leaves it alone.
 * (Renaming the lock away without this guard let a late breaker remove the winner's fresh lock:
 * tests/unit/concurrency/history-lock.test.ts saw 3 simultaneous holders.)
 */
async function breakStaleLock(
  file: string,
  seen: LockInfo | null,
  now: () => number,
  staleMs: number,
  heartbeatStaleMs: number,
): Promise<void> {
  const breaker = `${file}.break`;
  try {
    createTempSync(breaker); // registered: a hard exit inside the critical section removes it
  } catch (e) {
    if (code(e) !== "EEXIST" && !RETRY_CODES.has(code(e) ?? "")) throw e;
    // Another waiter is breaking it right now; clear a breaker file abandoned by a crashed process.
    try {
      const st = await stat(breaker);
      if (Date.now() - st.mtimeMs > BREAK_STALE_MS) await unlink(breaker).catch(() => {});
    } catch {
      // gone already
    }
    await delay(1);
    return;
  }
  try {
    const cur = await readLock(file);
    const stillStale = cur
      ? (seen === null || cur.token === seen.token) &&
        (isStale(cur, now(), staleMs) || (await heartbeatStopped(file, cur, heartbeatStaleMs)))
      : await unreadableLockIsOld(file, Math.min(staleMs, UNREADABLE_GRACE_MS));
    if (stillStale) await unlink(file).catch(() => {});
  } finally {
    await unlink(breaker).catch(() => {});
    releaseTemp(breaker);
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
  const heartbeatMs = opts.heartbeatMs ?? 1_000;
  const heartbeatStaleMs = opts.heartbeatStaleMs ?? 5_000;
  await mkdir(path.dirname(file), { recursive: true });
  const token = randomBytes(8).toString("hex");
  const deadline = now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    let got = false;
    try {
      got = await createLockFile(file, { pid: process.pid, host: hostname(), at: now(), token });
    } catch (e) {
      if (!RETRY_CODES.has(code(e) ?? "")) throw e;
    }
    if (got) {
      let released = false;
      const beat = setInterval(() => {
        const t = new Date();
        utimes(file, t, t).catch(() => {});
      }, heartbeatMs);
      beat.unref();
      return async () => {
        if (released) return;
        released = true;
        clearInterval(beat);
        const cur = await readLock(file);
        if (cur && cur.token !== token) return; // someone broke our (stale) lock; not ours to delete
        await unlink(file).catch(() => {});
      };
    }
    const holder = await readLock(file);
    // An unreadable lock may be mid-creation by its holder: judge it by mtime instead.
    const stale = holder
      ? isStale(holder, now(), staleMs) || (await heartbeatStopped(file, holder, heartbeatStaleMs))
      : await unreadableLockIsStale(file, Math.min(staleMs, UNREADABLE_GRACE_MS));
    if (stale) {
      await breakStaleLock(file, holder, now, staleMs, heartbeatStaleMs);
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
