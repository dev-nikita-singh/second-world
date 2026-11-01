/**
 * Suspicion 1b (PLAN-wave8 §sw-robust-w8): a second Ctrl+C calls process.exit(130) at once; writes in
 * flight (report temp files, history body temp files, the history `.lock`) must not be left behind.
 * The handler now removes this process's own temp files and lock synchronously before exiting
 * (src/cli/run-common.ts). docs/02-architecture.md §4.6.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";
import { LEFTOVER, TSX_LOADER, walk } from "../concurrency/helpers.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "double-sigint-writer.ts",
);

let tmp: TmpDir;
beforeEach(async () => {
  tmp = await makeTmpDir("sw-2sigint-");
});
afterEach(async () => {
  await tmp.cleanup();
});

describe("double Ctrl+C during writes", () => {
  it("exit 130 leaves no temp or lock files (10 runs at different moments)", async () => {
    const leftovers: string[] = [];
    for (let i = 0; i < 10; i++) {
      const root = tmp.join(`r${i}`);
      const outDir = path.join(root, "out");
      const hist = path.join(root, "history");
      mkdirSync(outDir, { recursive: true });
      mkdirSync(hist, { recursive: true });
      const r = await execa(process.execPath, ["--import", TSX_LOADER, FIXTURE, outDir, hist], {
        reject: false,
        timeout: 60_000,
        env: { SW_TEST_SIGINT_AFTER_MS: String(400 + i * 37) },
        stdin: "ignore",
        windowsHide: true,
      });
      expect(r.exitCode, String(r.stderr)).toBe(130);
      for (const f of walk(root)) if (LEFTOVER.test(f)) leftovers.push(`run ${i}: ${f}`);
    }
    expect(leftovers).toEqual([]);
  }, 180_000);
});
