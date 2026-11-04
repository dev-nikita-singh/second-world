/**
 * `sw evolve` from the CLI (owner: sw-qa, wave 5). docs/03-engines/experiments.md Part B, docs/09 §1 exit codes.
 *
 * Regression (fixed in 1faacab): in the docker sandbox an app listening on 127.0.0.1 never became healthy;
 * the run retried every rep for 30 s each (5 min), gave no hint about $HOST and exited 70 ("bug in
 * SECOND WORLD"). Now: hint about $HOST, arm skipped after 2 failed starts, baseline never healthy → exit 5.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempRepo, type TempRepo } from "../fixtures/experiments/git-repo.js";
import { runCli } from "../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";
import { dockerAvailable } from "../integration/docker/helpers.js";

const GITIGNORE = [".second-world/", ""].join("\n");
let repo: TempRepo;
let userCfg: TmpDir;

beforeEach(async () => {
  repo = await createTempRepo({ dirty: false });
  userCfg = await makeTmpDir("sw-qa5-evo-ucfg-");
  // config next to the repo root: `--repo` defaults to the config's folder
  writeFileSync(
    path.join(repo.dir, "sw.config.json"),
    JSON.stringify({
      targets: { api: { url: "http://127.0.0.1:1" } },
      safety: { allowHosts: ["127.0.0.1"] },
      evolution: {
        readyWhen: { path: "/healthz", timeout: "2s", interval: 100 },
        workload: { vus: 2, duration: "700ms", scenarios: [{ name: "w", steps: [{ path: "/work" }] }] },
      },
    }),
  );
});
afterEach(async () => {
  await repo.cleanup();
  await userCfg.cleanup();
});

const sw = (args: string[], timeoutMs = 120_000) =>
  runCli(args, { cwd: repo.dir, env: { SW_USER_CONFIG_DIR: userCfg.path }, timeoutMs });

describe("sw evolve (process sandbox)", () => {
  it("needs approval for the process sandbox (exit 3)", async () => {
    const r = await sw([
      "evolve",
      "--candidates",
      "branch:fix/fast",
      "--start",
      "node server.mjs",
      "--sandbox",
      "process",
    ]);
    expect(r.exitCode, r.stderr.slice(-1500)).toBe(3);
    expect(r.stderr).toMatch(/--yes|approv/i);
  });

  it("an app that never becomes healthy: exit 5 with a hint, fast, worktrees cleaned", async () => {
    const t0 = Date.now();
    const r = await sw([
      "--yes",
      "evolve",
      "--candidates",
      "branch:fix/fast",
      "--sandbox",
      "process",
      "--start",
      "node -e setInterval(()=>{},1000)",
      "--health",
      "/healthz",
      "--repetitions",
      "5",
      "--no-history",
    ]);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(5);
    expect(r.stdout + r.stderr).toMatch(/\$PORT|\$HOST/);
    expect(r.stdout + r.stderr).not.toMatch(/Internal error/);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect((await repo.git("worktree", "list")).split("\n")).toHaveLength(1); // only the user's own tree
  });

  // Fixed (main, wave 5; was reported by sw-qa 2026-10-29): without `.second-world/` in .gitignore, SECOND WORLD's own audit/report files
  // in the repo change the working-tree checksum → EVOLUTION-WORKING-TREE-CHANGED, exit 70 (experiments/git.ts:80).
  it("its own .second-world output does not count as a working-tree change (no .gitignore)", async () => {
    const r = await sw([
      "--yes",
      "evolve",
      "--candidates",
      "branch:fix/fast",
      "--sandbox",
      "process",
      "--start",
      "node server.mjs",
      "--health",
      "/healthz",
      "--repetitions",
      "5",
      "--no-history",
    ]);
    expect(r.stdout).not.toMatch(/CHANGED during the run/);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
  }, 180_000);

  it("ranks a faster branch on the Pareto front, rejects a failing one (exit 0); the user's tree is untouched", async () => {
    writeFileSync(path.join(repo.dir, ".gitignore"), GITIGNORE); // what `sw init` adds
    const before = await repo.git("status", "--porcelain");
    const r = await sw([
      "--yes",
      "evolve",
      "--candidates",
      "branch:fix/fast,branch:fix/broken",
      "--sandbox",
      "process",
      "--start",
      "node server.mjs",
      "--test",
      "node test.mjs",
      "--health",
      "/healthz",
      "--repetitions",
      "5",
      "--json",
      "--no-history",
    ]);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    const res = JSON.parse(r.stdout).results[0];
    const text = JSON.stringify(res.data);
    expect(text).toContain("fix/fast");
    const cands = res.data.candidates as Array<{ name: string; status: string; pareto: boolean }>;
    expect(cands.find((c) => c.name === "fix/broken")?.status).toBe("rejected");
    expect(cands.find((c) => c.name === "fix/fast")?.pareto).toBe(true);
    expect(await repo.git("status", "--porcelain")).toBe(before);
  }, 180_000);
});

describe.skipIf(!dockerAvailable)("sw evolve --sandbox docker (live Docker)", () => {
  it("an app that binds $HOST is benchmarked inside containers", async () => {
    writeFileSync(path.join(repo.dir, ".gitignore"), GITIGNORE);
    const r = await sw(
      [
        "--yes",
        "evolve",
        "--candidates",
        "branch:fix/fast",
        "--sandbox",
        "docker",
        "--start",
        "node server.mjs",
        "--health",
        "/healthz",
        "--repetitions",
        "5",
        "--no-history",
      ],
      240_000,
    );
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    expect(r.stdout).toMatch(/sandbox\s+docker/);
    expect(r.stdout).toMatch(/Pareto front[\s\S]*fix\/fast/);
  }, 300_000);
});
