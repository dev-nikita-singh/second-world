/**
 * History writer lock under contention (docs/04-data-structures-and-algorithms.md §9.5, Plan wave 7 §A).
 * The lock must give mutual exclusion even when several waiters find the same stale lock at once.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withLock } from "../../../src/engines/history/index.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir;
beforeEach(async () => {
  tmp = await makeTmpDir("sw-lock-");
});
afterEach(async () => {
  await tmp.cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function contend(lock: string, n: number): Promise<number> {
  let inside = 0;
  let maxInside = 0;
  await Promise.all(
    Array.from({ length: n }, () =>
      withLock(
        lock,
        async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await sleep(5);
          inside--;
        },
        { timeoutMs: 20_000, pollMs: 1 },
      ),
    ),
  );
  return maxInside;
}

describe("history lock: mutual exclusion", () => {
  it("8 concurrent holders never overlap (no stale lock)", async () => {
    expect(await contend(tmp.join("h", ".lock"), 8)).toBe(1);
  });

  it("8 waiters racing to break the same stale lock: still at most one holder", async () => {
    const lock = tmp.join("h", ".lock");
    await mkdir(path.dirname(lock), { recursive: true });
    let worst = 0;
    for (let round = 0; round < 20; round++) {
      // dead pid on this host → stale for every waiter at the same moment
      await writeFile(
        lock,
        JSON.stringify({ pid: 4_194_000, host: hostname(), at: Date.now(), token: "dead" }),
      );
      worst = Math.max(worst, await contend(lock, 8));
    }
    expect(worst).toBe(1);
    // nothing left behind: no lock, no tomb/temp files
    expect(await readdir(path.dirname(lock))).toEqual([]);
  });
});

describe("history lock: abandoned lock files", () => {
  it("an empty lock (holder killed between create and write) is broken after a short grace, not 60 s", async () => {
    const { utimes } = await import("node:fs/promises");
    const { acquireLock } = await import("../../../src/engines/history/index.js");
    const lock = tmp.join("h", ".lock");
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, "");
    const old = new Date(Date.now() - 3_000);
    await utimes(lock, old, old);
    const t0 = performance.now();
    const release = await acquireLock(lock, { timeoutMs: 5_000 });
    expect(performance.now() - t0).toBeLessThan(2_000);
    await release();
  });

  it("a fresh empty lock is respected (may be mid-creation by a live writer)", async () => {
    const { acquireLock, LockTimeoutError } = await import("../../../src/engines/history/index.js");
    const lock = tmp.join("h", ".lock");
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, "");
    await expect(acquireLock(lock, { timeoutMs: 300 })).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it("a lock never appears without its owner record (no empty lock window)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { acquireLock } = await import("../../../src/engines/history/index.js");
    const lock = tmp.join("h", ".lock");
    const release = await acquireLock(lock);
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ pid: process.pid, host: hostname() });
    await release();
    expect(await readdir(path.dirname(lock))).toEqual([]); // no lock temp left
  });
});
