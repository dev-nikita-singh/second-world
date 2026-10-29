/** Temporary directories with reliable cleanup (Windows-safe: retries on EBUSY/EPERM). */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TmpDir {
  path: string;
  /** Join a relative path inside the temp dir. */
  join(...parts: string[]): string;
  cleanup(): Promise<void>;
}

/** Create a fresh temp dir under the OS temp folder. Call `cleanup()` in afterEach. */
export async function makeTmpDir(prefix = "sw-test-"): Promise<TmpDir> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    path: dir,
    join: (...parts) => path.join(dir, ...parts),
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

/** Run `fn` with a temp dir that is always removed afterwards. */
export async function withTmpDir<T>(fn: (dir: TmpDir) => Promise<T>, prefix?: string): Promise<T> {
  const dir = await makeTmpDir(prefix);
  try {
    return await fn(dir);
  } finally {
    await dir.cleanup();
  }
}
