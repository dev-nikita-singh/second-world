/**
 * `<lock>.break` left by a writer SIGKILLed while breaking a stale lock (seen once in
 * tests/integration/concurrency/cli-parallel.test.ts under full-suite load): the breaker writes its pid, so
 * an abandoned file is cleared at once (by the next breaker or `prune`) instead of staying forever.
 */

import { spawnSync } from "node:child_process";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAbandonedBreaker } from "../../../src/engines/history/fsutil.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir;
beforeEach(async () => {
  tmp = await makeTmpDir("sw-breaker-");
});
afterEach(async () => {
  await tmp.cleanup();
});

/** A pid that existed and is now gone. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(r.stdout);
}

describe("clearAbandonedBreaker", () => {
  it("removes the breaker of a dead process at once", async () => {
    const lock = tmp.join(".lock");
    writeFileSync(`${lock}.break`, String(deadPid()));
    await clearAbandonedBreaker(lock);
    expect(existsSync(`${lock}.break`)).toBe(false);
  });

  it("keeps a fresh breaker of a live process (or of this one)", async () => {
    const lock = tmp.join(".lock");
    for (const pid of [process.ppid, process.pid]) {
      writeFileSync(`${lock}.break`, String(pid));
      await clearAbandonedBreaker(lock);
      expect(existsSync(`${lock}.break`), String(pid)).toBe(true);
    }
  });

  it("removes any breaker older than 5 s (pid reuse, other host, old empty file)", async () => {
    const lock = tmp.join(".lock");
    writeFileSync(`${lock}.break`, "");
    const old = (Date.now() - 10_000) / 1000;
    utimesSync(`${lock}.break`, old, old);
    await clearAbandonedBreaker(lock);
    expect(existsSync(`${lock}.break`)).toBe(false);
  });

  it("is a no-op without a breaker file", async () => {
    await expect(clearAbandonedBreaker(tmp.join(".lock"))).resolves.toBeUndefined();
  });
});
