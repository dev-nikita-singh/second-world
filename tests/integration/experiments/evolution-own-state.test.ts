/**
 * Evolution must not report its own state files as a "working tree change" (sw-qa wave 5 bug), and a
 * genuine change of the user's working tree during the run is a user-side problem: status "failed"
 * (exit 1) with the invalidating EVOLUTION-WORKING-TREE-CHANGED limitation, never exit 70.
 * docs/03-engines/experiments.md §B (working tree).
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import { runEvolution, workingTreeChecksum } from "../../../src/engines/experiments/index.js";
import { computeVerdict } from "../../../src/engines/reporting/model.js";
import { createTempRepo, type TempRepo } from "../../fixtures/experiments/git-repo.js";
import { runCli } from "../../helpers/cli.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

let repo: TempRepo;
beforeEach(async () => {
  repo = await createTempRepo({ dirty: false });
});
afterEach(async () => {
  await repo?.cleanup();
});

describe("Evolution working-tree checksum vs SECOND WORLD's own files", () => {
  it("config at the repo root, no .gitignore: own .second-world/ writes are not a change (exit 0)", async () => {
    writeFileSync(
      join(repo.dir, "sw.config.json"),
      JSON.stringify({
        performance: {
          vus: 2,
          duration: "600ms",
          warmup: "200ms",
          scenarios: [{ name: "w", steps: [{ path: "/work" }] }],
        },
        report: { outDir: "out/sw-reports" },
        history: { dir: "sw-history" },
      }),
    );
    await repo.git("add", "sw.config.json");
    await repo.git("commit", "-q", "-m", "config");
    const r = await runCli(
      [
        "--yes",
        "--seed",
        "5",
        "-f",
        "json",
        "evolve",
        "--candidates",
        "branch:fix/fast",
        "--sandbox",
        "process",
        "--start",
        `"${process.execPath}" server.mjs`,
        "--health",
        "/healthz",
        "--repetitions",
        "5",
        "--json",
      ],
      { cwd: repo.dir, env, timeoutMs: 150_000 },
    );
    const res = JSON.parse(r.stdout).results[0];
    expect(res.data.workingTree.unchanged, JSON.stringify(res.limitations)).toBe(true);
    expect(res.limitations.map((l: { code: string }) => l.code)).not.toContain(
      "EVOLUTION-WORKING-TREE-CHANGED",
    );
    expect(r.exitCode, r.stderr.slice(-2000)).not.toBe(70);
    expect([0, 1]).toContain(r.exitCode);
  }, 160_000);

  it("a genuine change of the user's working tree during the run: failed (exit 1), not an engine error (70)", async () => {
    const intruder = join(repo.dir, "intruder.txt").replace(/\\/g, "/");
    const res = await runEvolution(
      {
        repo: repo.dir,
        candidates: ["branch:fix/fast"],
        health: "/healthz",
        start: [process.execPath, "server.mjs"],
        // The "test suite" writes into the user's checkout (not the worktree): a real change under us.
        test: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(intruder)}, "x")`],
        workload: {
          vus: 2,
          duration: "600ms",
          warmup: "200ms",
          scenarios: [{ name: "w", steps: [{ path: "/work" }] }],
        },
        metrics: ["p50", "p95"],
        design: { repetitions: 5, seed: 5 },
        sandbox: { kind: "process" },
      },
      { safety: createSafetyGuard({}, { interactive: false, approve: true }) },
    );
    expect(res.data?.workingTree.unchanged).toBe(false);
    const lim = res.limitations.find((l) => l.code === "EVOLUTION-WORKING-TREE-CHANGED");
    expect(lim?.impact).toBe("invalidates");
    expect(res.status).toBe("failed");
    expect(computeVerdict([res]).exitCode).toBe(1);
  }, 160_000);

  it("excludes .second-world/ anywhere and the given ignorePaths from the checksum", async () => {
    const before = await workingTreeChecksum(repo.dir, ["sw-state"]);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repo.dir, ".second-world", "history"), { recursive: true });
    writeFileSync(join(repo.dir, ".second-world", "audit.log"), "{}\n");
    mkdirSync(join(repo.dir, "sub", ".second-world"), { recursive: true });
    writeFileSync(join(repo.dir, "sub", ".second-world", "x.json"), "{}");
    mkdirSync(join(repo.dir, "sw-state"), { recursive: true });
    writeFileSync(join(repo.dir, "sw-state", "r.json"), "{}");
    expect(await workingTreeChecksum(repo.dir, [join(repo.dir, "sw-state")])).toBe(before);
    writeFileSync(join(repo.dir, "user.txt"), "user change");
    expect(await workingTreeChecksum(repo.dir, ["sw-state"])).not.toBe(before);
  }, 60_000);
});
