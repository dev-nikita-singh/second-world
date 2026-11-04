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
  it("A/A on the tiny server: exit 0, or exit 1 with the AA-difference limitation", async () => {
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
    const why = `${r.stderr.slice(-1500)}\n${aaSummary(r.stdout)}`;
    expect([0, 1], why).toContain(r.exitCode);
    const res = JSON.parse(r.stdout).results[0];
    expect(res.engine).toBe("whatif");
    expect(res.data.mode).toBe("aa");
    const verdicts = (res.data.comparisons as Array<{ verdict: string }>).map((c) => c.verdict);
    expect(verdicts.length).toBeGreaterThan(0);
    const differs = verdicts.some((v) => v === "improved" || v === "regressed");
    const aaLimitation = (res.limitations as Array<{ code: string; impact: string }>).find(
      (l) => l.code === "WHATIF-AA-DIFFERENCE",
    );
    // An A/A run tests the ENVIRONMENT: identical arms are compared at alpha 0.05 (Holm), so a significant
    // difference is a legitimate, reported outcome, not a bug. It is rare on a quiet machine (32/32 standalone
    // runs on macOS CI runners were clean) but happened under the full parallel suite on 3-vCPU macOS
    // runners, where run-to-run noise is not exchangeable. What must always hold is the contract: exit 0
    // when no verdict is improved/regressed; otherwise exit 1, status "failed" and the invalidating
    // WHATIF-AA-DIFFERENCE limitation that tells the user the environment is too unstable for comparisons.
    if (differs) {
      expect(r.exitCode, why).toBe(1);
      expect(res.status).toBe("failed");
      expect(aaLimitation?.impact).toBe("invalidates");
    } else {
      expect(r.exitCode, why).toBe(0);
      expect(res.status).toBe("passed");
      expect(aaLimitation).toBeUndefined();
      expect(verdicts.every((v) => v === "no-significant-change" || v === "inconclusive")).toBe(true);
    }
    // Whether 5 x 800 ms runs are precise enough to also show equivalence depends on the machine: on shared
    // macOS CI runners both metrics were honestly "inconclusive". tests/integration/experiments/whatif-shop.test.ts
    // checks the equivalence bounds whenever equivalence is shown.
    const list = await runCli(["history", "list", "--json"], { cwd: dir, env });
    expect(JSON.parse(list.stdout)[0]).toMatchObject({ label: "whatif" });
  }, 130_000);
});

/** Per-comparison and per-run numbers of an A/A JSON report, for the failure message. */
function aaSummary(stdout: string): string {
  try {
    const res = JSON.parse(stdout).results[0];
    const lines = [
      `status ${res.status}; limitations ${res.limitations.map((l: { code: string }) => l.code).join(",")}`,
    ];
    for (const c of res.data.comparisons)
      lines.push(
        `${c.metric}: ${c.verdict} rel ${c.relativeChange.toFixed(4)} CI [${c.ci.lower.toFixed(4)}, ${c.ci.upper.toFixed(4)}] p ${c.p.toFixed(4)} pHolm ${c.pAdjusted.toFixed(4)}`,
      );
    for (const run of res.data.runs)
      lines.push(
        `#${run.index} ${run.arm} ${run.status} p50 ${run.metrics.p50?.toFixed(2)} p95 ${run.metrics.p95?.toFixed(2)}`,
      );
    return lines.join("\n");
  } catch {
    return stdout.slice(0, 1500);
  }
}

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
        // 7, not 5: with 3 metrics x 2 benchmarked candidates Holm needs p < 0.05/6 at its first step, and
        // 5 vs 5 runs reach only p = 0.0079 with complete separation; one stalled run on a loaded runner made
        // fix/fast's p95 gain "inconclusive" (counted as 0), so fix/slower tied it on the front (macOS CI).
        "--repetitions",
        "7",
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
