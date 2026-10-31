/**
 * `sw whatif --aa` and `sw evolve --sandbox process --yes` end to end (owner: sw-core).
 * Apps are sw-experiments' tiny-server fixture (started by the engine per run, free PORT) and its
 * temp git repo fixture. The CLI runs in a separate temp cwd so reports/history never touch the repo.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workingTreeChecksum } from "../../../src/engines/experiments/index.js";
import { createTempRepo, type TempRepo } from "../../fixtures/experiments/git-repo.js";
import { REPO_ROOT, runCli } from "../../helpers/cli.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

describe("sw whatif --aa (subprocess)", () => {
  it("A/A on the tiny server: exit 0, no significant change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-whatif-cli-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(
      join(dir, "aa.json"),
      JSON.stringify({
        name: "aa-tiny",
        baseline: {
          start: [process.execPath, join(REPO_ROOT, "tests", "fixtures", "experiments", "tiny-server.mjs")],
          env: { DELAY_MS: "20" },
          readyWhen: { path: "/healthz" },
        },
        workload: {
          vus: 2,
          duration: "800ms",
          warmup: "200ms",
          scenarios: [{ name: "w", steps: [{ path: "/work" }] }],
        },
        metrics: ["p50", "p95"],
      }),
    );
    const r = await runCli(
      ["--seed", "3", "-f", "json", "whatif", "aa.json", "--aa", "--repetitions", "5", "--json"],
      {
        cwd: dir,
        env,
        timeoutMs: 120_000,
      },
    );
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    const res = JSON.parse(r.stdout).results[0];
    expect(res.engine).toBe("whatif");
    expect(res.data.mode).toBe("aa");
    const verdicts = (res.data.comparisons as Array<{ verdict: string }>).map((c) => c.verdict);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(
      verdicts.every((v) => v === "no-significant-change" || v === "inconclusive"),
      verdicts.join(","),
    ).toBe(true);
    expect(verdicts).toContain("no-significant-change");
    const list = await runCli(["history", "list", "--json"], { cwd: dir, env });
    expect(JSON.parse(list.stdout)[0]).toMatchObject({ label: "whatif" });
  }, 130_000);
});

describe("sw evolve --sandbox process --yes (subprocess, temp git repo)", () => {
  let repo: TempRepo;
  let dir: string;
  beforeAll(async () => {
    repo = await createTempRepo();
    dir = mkdtempSync(join(tmpdir(), "sw-evolve-cli-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(
      join(dir, "sw.config.json"),
      JSON.stringify({
        performance: {
          vus: 2,
          duration: "800ms",
          warmup: "200ms",
          scenarios: [{ name: "w", steps: [{ path: "/work" }] }],
        },
        evolution: { metrics: ["p50", "p95", "rps"], success: { p95: { improvement: ">= 15%" } } },
      }),
    );
  });
  afterAll(async () => {
    await repo?.cleanup();
  });

  it("ranks fix/fast on the Pareto front, rejects fix/broken, leaves the working tree unchanged", async () => {
    const before = await workingTreeChecksum(repo.dir);
    const r = await runCli(
      [
        "--yes",
        "--seed",
        "5",
        "-f",
        "json",
        "evolve",
        "--repo",
        repo.dir,
        "--candidates",
        "branch:fix/fast,branch:fix/broken,branch:fix/slower",
        "--start",
        `"${process.execPath}" server.mjs`,
        "--test",
        `"${process.execPath}" test.mjs`,
        "--health",
        "/healthz",
        "--repetitions",
        "5",
        "--sandbox",
        "process",
        "--json",
      ],
      { cwd: dir, env, timeoutMs: 150_000 },
    );
    expect(r.exitCode, r.stderr.slice(-3000)).toBe(0);
    const res = JSON.parse(r.stdout).results[0];
    expect(res.engine).toBe("evolution");
    expect(res.status).toBe("passed");
    const d = res.data;
    expect(d.paretoFront).toEqual(["fix/fast"]);
    const fast = d.candidates.find((c: { name: string }) => c.name === "fix/fast");
    expect(fast.rank).toBe(1);
    expect(d.rejected.map((x: { name: string }) => x.name)).toEqual(["fix/broken"]);
    expect(d.workingTree.unchanged).toBe(true);
    expect(await workingTreeChecksum(repo.dir)).toBe(before);
  }, 160_000);
});
