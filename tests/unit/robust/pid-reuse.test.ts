/**
 * Wave 8 robustness (PLAN-wave8 §sw-robust-w8, suspicion 1a): Windows reuses PIDs quickly. When a
 * history writer dies while holding `.lock` and another process gets its pid, the "dead pid" check
 * says the holder is alive, so waiters used to wait for the 60 s age limit — past their 10 s timeout
 * (LockTimeoutError, the run's history save is lost). The holder now refreshes the lock's mtime
 * (heartbeat); a lock whose heartbeat stopped is stale even when its pid is alive.
 * docs/02-architecture.md §4.6.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, LockTimeoutError } from "../../../src/engines/history/index.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir;
let child: ChildProcess | undefined;
beforeEach(async () => {
  tmp = await makeTmpDir("sw-pidreuse-");
});
afterEach(async () => {
  child?.kill();
  child = undefined;
  await tmp.cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A live process that is NOT the lock's real owner: stands in for "the dead holder's pid was reused". */
async function liveForeignPid(): Promise<number> {
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise<void>((r, j) => {
    child?.once("spawn", () => r());
    child?.once("error", j);
  });
  return child.pid as number;
}

describe("history lock vs pid reuse", () => {
  it("a lock whose holder died (pid now reused by a live process) is broken once its heartbeat is old", async () => {
    const lock = tmp.join("h", ".lock");
    await mkdir(path.dirname(lock), { recursive: true });
    const pid = await liveForeignPid();
    // holder died 6 s ago; its pid now belongs to an unrelated live process
    const diedAt = Date.now() - 6_000;
    await writeFile(lock, JSON.stringify({ pid, host: hostname(), at: diedAt, token: "reused" }));
    await utimes(lock, new Date(diedAt), new Date(diedAt));
    const t0 = performance.now();
    const release = await acquireLock(lock, { timeoutMs: 2_000 });
    expect(performance.now() - t0).toBeLessThan(1_500);
    await release();
  });

  it("a live holder keeps its lock past the heartbeat window (heartbeat refreshes mtime)", async () => {
    const lock = tmp.join("h", ".lock");
    const opts = { heartbeatMs: 50, heartbeatStaleMs: 400 };
    const release = await acquireLock(lock, opts);
    const m0 = (await stat(lock)).mtimeMs;
    // a waiter must not break it while the holder is alive and beating, even after 3x the window
    await expect(acquireLock(lock, { ...opts, timeoutMs: 1_200 })).rejects.toBeInstanceOf(LockTimeoutError);
    expect((await stat(lock)).mtimeMs).toBeGreaterThan(m0);
    const waiter = acquireLock(lock, { ...opts, timeoutMs: 3_000 });
    await sleep(100);
    await release();
    await (await waiter)();
  });

  it("a fresh lock of a live foreign pid is respected (no false break)", async () => {
    const lock = tmp.join("h", ".lock");
    await mkdir(path.dirname(lock), { recursive: true });
    const pid = await liveForeignPid();
    await writeFile(lock, JSON.stringify({ pid, host: hostname(), at: Date.now(), token: "live" }));
    await expect(acquireLock(lock, { timeoutMs: 300 })).rejects.toBeInstanceOf(LockTimeoutError);
  });
});
