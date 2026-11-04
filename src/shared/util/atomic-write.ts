/**
 * Crash-safe atomic file writes: write a uniquely named sibling temp file, then rename over the
 * target (docs/03-engines/evidence-and-history.md §B.1). Unique temp names make concurrent writers
 * of one file safe (last rename wins, never a torn file).
 *
 * Windows: `rename` over an existing file can fail transiently with EPERM/EBUSY/EACCES
 * while antivirus or an indexer holds a handle; we retry with a short backoff.
 *
 * The temp is created on the main thread and registered (src/shared/util/fs-temp.ts) so a hard exit
 * (second Ctrl+C) removes it reliably; the data is then written without O_CREAT.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempSync, releaseTemp } from "./fs-temp.js";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES", "EEXIST", "ENOTEMPTY"]);

export interface AtomicWriteOptions {
  /** Max rename attempts (default 10). */
  retries?: number;
  /** Base delay between attempts in ms, doubled up to 200 ms (default 10). */
  retryDelayMs?: number;
  /** Injected for tests. */
  renameImpl?: (from: string, to: string) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Write `data` to `file` atomically: write a sibling temp file, then rename over the target. */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  createTempSync(tmp);
  try {
    // "r+": never re-creates a temp that a hard exit already removed.
    await writeFile(tmp, data, { flag: "r+" });
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    releaseTemp(tmp);
    throw e;
  }
  const doRename = opts.renameImpl ?? rename;
  const retries = Math.max(1, opts.retries ?? 10);
  let delay = opts.retryDelayMs ?? 10;
  for (let attempt = 1; ; attempt++) {
    try {
      await doRename(tmp, file);
      releaseTemp(tmp);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (attempt >= retries || !RETRYABLE.has(code)) {
        await rm(tmp, { force: true }).catch(() => undefined);
        releaseTemp(tmp);
        throw e;
      }
      await sleep(delay);
      delay = Math.min(200, delay * 2);
    }
  }
}
