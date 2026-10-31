/**
 * F8: statistical `sw history diff` from CLI runs (owner: sw-core).
 * 5 labeled perf runs on /fixed/10 and 5 on /fixed/60 (calibrated server in a child process),
 * then `diff label:fast label:slow` must report a statistical regression and exit 1.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ChildCalibratedServer,
  startCalibratedServerInChild,
} from "../../fixtures/servers/calibrated-child.js";
import { runCli } from "../../helpers/cli.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

describe("sw history diff with multiple runs per side", () => {
  let srv: ChildCalibratedServer;
  let dir: string;
  beforeAll(async () => {
    srv = await startCalibratedServerInChild();
    dir = mkdtempSync(join(tmpdir(), "sw-hdiff-"));
    mkdirSync(join(dir, ".git"));
  }, 30_000);
  afterAll(async () => {
    await srv?.close();
  });

  it("label:fast vs label:slow → statistical regression, exit 1; last:N with --label works", async () => {
    const perf = (label: string, ms: number) =>
      runCli(
        [
          "--label",
          label,
          "-f",
          "json",
          "perf",
          `${srv.url}/fixed/${ms}`,
          "--iterations",
          "30",
          "--vus",
          "2",
          "--json",
        ],
        {
          cwd: dir,
          env,
          timeoutMs: 60_000,
        },
      );
    for (let i = 0; i < 5; i++) {
      const r = await perf("fast", 10);
      expect(r.exitCode, r.stderr).toBe(0);
    }
    for (let i = 0; i < 5; i++) {
      const r = await perf("slow", 60);
      expect(r.exitCode, r.stderr).toBe(0);
    }
    const list = JSON.parse(
      (await runCli(["history", "list", "--json", "--limit", "20"], { cwd: dir, env })).stdout,
    ) as Array<{ label: string }>;
    expect(list.filter((e) => e.label === "fast")).toHaveLength(5);

    const d = await runCli(["history", "diff", "label:fast", "label:slow", "--json"], { cwd: dir, env });
    expect(d.exitCode, d.stderr).toBe(1);
    const cmp = JSON.parse(d.stdout);
    expect(cmp.baselineIds).toHaveLength(5);
    expect(cmp.currentIds).toHaveLength(5);
    expect(cmp.method).toBe("statistical");
    const p95 = (cmp.metrics as Array<{ metric: string; verdict: string; method: string }>).find((m) =>
      /p95/.test(m.metric),
    );
    expect(p95).toMatchObject({ method: "statistical", verdict: "regressed" });
    expect(cmp.regressions.length).toBeGreaterThan(0);

    // reverse direction: improvement, no regression → exit 0
    const rev = await runCli(["history", "diff", "label:slow", "label:fast", "--json"], { cwd: dir, env });
    expect(rev.exitCode, rev.stderr).toBe(0);

    // last:N filtered by the global --label, and a comma list
    const fastIds = list.filter((e) => e.label === "fast").map((e) => (e as unknown as { id: string }).id);
    const lastN = await runCli(
      ["--label", "fast", "history", "diff", "last:5", fastIds.slice(0, 3).join(","), "--json"],
      { cwd: dir, env },
    );
    expect([0, 1]).toContain(lastN.exitCode);
    expect(JSON.parse(lastN.stdout).baselineIds).toHaveLength(5);
  }, 240_000);
});
