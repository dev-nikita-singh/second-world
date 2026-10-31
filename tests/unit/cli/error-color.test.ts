/**
 * Errors go to stderr; colour them only when stderr is a terminal (or FORCE_COLOR), never into a
 * pipe or a CI log file (reported by sw-ship7, wave 7: `sw perf 2>&1 | cat` printed raw ESC[31m).
 */
import { afterEach, describe, expect, it } from "vitest";
import { colorEnabled } from "../../../src/cli/output.js";
import { runCli } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir | undefined;
afterEach(async () => {
  await tmp?.cleanup();
  tmp = undefined;
});

describe("error output colour", () => {
  it("colorEnabled follows the stream it is given", () => {
    const saved = { ...process.env };
    try {
      delete process.env.NO_COLOR;
      delete process.env.FORCE_COLOR;
      delete process.env.TERM;
      expect(colorEnabled({}, { isTTY: false })).toBe(false);
      expect(colorEnabled({}, { isTTY: true })).toBe(true);
      expect(colorEnabled({ color: false }, { isTTY: true })).toBe(false);
      process.env.FORCE_COLOR = "1";
      expect(colorEnabled({}, { isTTY: false })).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it("a config error written to a pipe has no ANSI escapes", async () => {
    tmp = await makeTmpDir("sw-err-color-");
    const r = await runCli(["perf"], { cwd: tmp.path, env: { NO_COLOR: undefined } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for raw ESC
    expect(r.stderr).not.toMatch(/\u001b\[/);
  });
});
