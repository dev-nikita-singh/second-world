/**
 * Suspicion 1e (PLAN-wave8 §sw-robust-w8): local file retries (history lock polling, rename retry)
 * back off without jitter, so waiters of different processes could wake in lockstep and starve or
 * time out. Measured with 12 processes × 15 appends on one history dir: no failure, no lost record,
 * worst single append under the 10 s lock timeout (~2 s alone, 6.2 s while the full suite ran) → no harm shown; retries left unchanged.
 * (Numbers recorded in .agents/progress/sw-robust-w8.md.)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";
import { TSX_LOADER } from "../concurrency/helpers.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "lock-contender.ts");
const PROCS = 12;
const EACH = 15;

let tmp: TmpDir;
beforeEach(async () => {
  tmp = await makeTmpDir("sw-contend-");
});
afterEach(async () => {
  await tmp.cleanup();
});

describe("history lock under cross-process contention (no jitter)", () => {
  it(`${PROCS} processes × ${EACH} appends: none fails, none lost, bounded wait`, async () => {
    const dir = tmp.join("history");
    const rs = await Promise.all(
      Array.from({ length: PROCS }, (_, i) =>
        execa(process.execPath, ["--import", TSX_LOADER, FIXTURE, dir, `p${i}`, String(EACH)], {
          reject: false,
          timeout: 120_000,
          stdin: "ignore",
          windowsHide: true,
        }),
      ),
    );
    const stats = rs.map((r) => {
      expect(r.exitCode, String(r.stderr)).toBe(0);
      return JSON.parse(String(r.stdout).trim()) as {
        ok: number;
        failed: number;
        maxMs: number;
        totalMs: number;
      };
    });
    const worst = Math.max(...stats.map((s) => s.maxMs));
    console.info(
      `[lock-contention] ${PROCS}x${EACH}: worst append ${worst} ms, slowest process ${Math.max(...stats.map((s) => s.totalMs))} ms`,
    );
    expect(stats.reduce((a, s) => a + s.failed, 0)).toBe(0);
    const lines = (await readFile(path.join(dir, "runs.jsonl"), "utf8")).trim().split("\n");
    expect(lines.length).toBe(PROCS * EACH);
    // harm = a waiter reaching the 10 s lock timeout (LockTimeoutError = lost history save)
    expect(worst).toBeLessThan(10_000);
  }, 180_000);
});
