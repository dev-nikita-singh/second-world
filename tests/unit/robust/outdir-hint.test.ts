/**
 * The SW_CONFIG_OUTDIR hint names the real global flag (`-o, --out <dir>` in `sw --help`), not the
 * non-existent `--out-dir` (reported by main, wave 8).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReportDirWritable } from "../../../src/cli/run-common.js";
import { ConfigError } from "../../../src/core/errors.js";
import type { World } from "../../../src/core/world.js";

function fakeWorld(cwd: string, outDir: string): World {
  return { config: { cwd, config: { report: { outDir, formats: ["json"] } } } } as unknown as World;
}

describe("report dir preflight hint", () => {
  it("names -o/--out <dir>, never --out-dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-outhint-"));
    writeFileSync(join(dir, "afile"), "x");
    let caught: unknown;
    try {
      assertReportDirWritable(fakeWorld(dir, "afile/sub"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const hint = (caught as ConfigError).hint ?? "";
    expect(hint).toContain("-o/--out <dir>");
    expect(hint).not.toContain("--out-dir");
  });
});
