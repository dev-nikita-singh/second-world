/**
 * `sw inspect /nonexistent/dir` exits 2 (usage/config error) with a clear message (sw-qa wave 5 bug).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../helpers/cli.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

describe("sw inspect <missing path>", () => {
  it("exits 2 and names the path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sw-inspect-missing-"));
    const missing = join(cwd, "nonexistent", "dir");
    const r = await runCli(["inspect", missing], { cwd, env, timeoutMs: 60_000 });
    expect(r.exitCode, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain("does not exist");
    expect(r.stderr).toContain(missing);
  }, 70_000);
});
