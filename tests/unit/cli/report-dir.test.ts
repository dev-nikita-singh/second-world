/**
 * Regression reported by sw-qa (wave 5): an unwritable `-o` dir surfaced as an internal error
 * (exit 70 + stack) after the run, and the run was lost from history. Now the report dir is
 * checked before the run (exit 2, no side effects).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReportDirWritable } from "../../../src/cli/run-common.js";
import type { World } from "../../../src/core/world.js";

function fakeWorld(cwd: string, outDir: string, formats: string[] = ["tty", "json"]): World {
  return { config: { cwd, config: { report: { outDir, formats } } } } as unknown as World;
}

describe("report dir preflight", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-outdir-"));
  writeFileSync(join(dir, "afile"), "x");

  it("a path below a regular file → ConfigError exit 2", () => {
    expect(() => assertReportDirWritable(fakeWorld(dir, "afile/sub"))).toThrow(
      expect.objectContaining({ code: "SW_CONFIG_OUTDIR", exitCode: 2 }),
    );
  });

  it("a not-yet-existing dir under a writable one is fine (nothing is created)", () => {
    expect(() => assertReportDirWritable(fakeWorld(dir, "new/deeper"))).not.toThrow();
  });

  it("tty-only output never checks the dir", () => {
    expect(() => assertReportDirWritable(fakeWorld(dir, "afile/sub", ["tty"]))).not.toThrow();
  });
});
