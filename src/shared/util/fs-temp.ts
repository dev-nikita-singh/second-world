/**
 * Process-wide registry of the temp files THIS process has created and not yet renamed or removed
 * (report temps of atomic-write.ts, history temps / lock temps / `.break` files of
 * src/engines/history/fsutil.ts). docs/02-architecture.md §4.6 (second Ctrl+C exits at once).
 *
 * Why temps are created synchronously: an async `open(tmp, O_CREAT)` is a request on the libuv thread
 * pool. A hard exit (second Ctrl+C → removeLiveTempsSync() → process.exit(130)) can run after the request
 * was queued but before a pool thread executed it; the pool keeps draining while the process tears down,
 * so the temp file appeared AFTER the synchronous sweep and stayed behind (macOS CI, and 6/20 runs on
 * Windows with tests/integration/robust/fixtures/double-sigint-burst.ts). Creating the directory entry on
 * the main thread (one openSync + closeSync) makes "registered" and "exists" the same event as seen from
 * the signal handler, which also runs on the main thread. Later async work on the temp opens it WITHOUT
 * O_CREAT, so a temp removed by the sweep is never re-created.
 */
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";

const live = new Set<string>();

/**
 * Creates `file` exclusively (O_EXCL) on the main thread, optionally with `content`, and registers it as
 * a live temp of this process. Throws like openSync (EEXIST, ENOENT …); nothing is registered then.
 */
export function createTempSync(file: string, content?: string | Uint8Array): void {
  // Registered only once WE created it: a contender's EEXIST on a shared name (`<lock>.break`) must not
  // unregister the winner's file. Nothing can run between openSync and add (same synchronous turn).
  const fd = openSync(file, "wx");
  live.add(file);
  try {
    if (content !== undefined) {
      const buf = typeof content === "string" ? Buffer.from(content) : content;
      let off = 0;
      while (off < buf.byteLength) off += writeSync(fd, buf, off, buf.byteLength - off);
    }
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(file);
    } catch {
      // best effort
    }
    live.delete(file);
    throw e;
  }
  closeSync(fd);
}

/** The temp was renamed away or removed: stop tracking it. */
export function releaseTemp(file: string): void {
  live.delete(file);
}

/** Temps currently registered (for tests and diagnostics). */
export function liveTemps(): string[] {
  return [...live];
}

/**
 * Hard-exit path: synchronously removes every registered temp. Never throws. A rename or link of one of
 * them still running on the thread pool then either already happened (nothing left to remove) or fails
 * with ENOENT; nothing re-creates a removed temp.
 */
export function removeLiveTempsSync(): void {
  for (const f of live) {
    try {
      unlinkSync(f);
    } catch {
      // already renamed or removed
    }
  }
  live.clear();
}
