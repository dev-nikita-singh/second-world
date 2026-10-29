import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import {
  lockInfo,
  materialize,
  parseShortStat,
  planInstall,
  runEvolution,
  type WorkloadRunner,
  WorktreeManager,
  workingTreeChecksum,
} from "../../../src/engines/experiments/index.js";
import { fakeResult } from "../../fixtures/experiments/fake-perf.js";
import { createTempRepo, type TempRepo } from "../../fixtures/experiments/git-repo.js";

const approved = () => createSafetyGuard({}, { interactive: false, approve: true });

/** Stub workload: latency from the candidate's delay.json (read via the app's /healthz is overkill). */
const stubWorkload: WorkloadRunner = async (input) => fakeResult(String(input.target), { p95: 50 });

let repo: TempRepo;
beforeEach(async () => {
  repo = await createTempRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

async function worktreeCount(): Promise<number> {
  return (await repo.git("worktree", "list", "--porcelain"))
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree ")).length;
}

describe("WorktreeManager", () => {
  it("creates detached worktrees without touching the working tree, and cleans up (links unlinked, not followed)", async () => {
    const before = await workingTreeChecksum(repo.dir);
    const mgr = new WorktreeManager(repo.dir);
    const head = await repo.git("rev-parse", "fix/fast");
    const wt = await mgr.add("fix/fast", head);
    expect(JSON.parse(await readFile(path.join(wt.dir, "delay.json"), "utf8"))).toEqual({ delayMs: 0 });
    expect(existsSync(path.join(wt.dir, "notes.txt"))).toBe(false);
    // a shared directory linked into the worktree must survive cleanup
    const shared = await mkdtemp(path.join(os.tmpdir(), "sw-shared-"));
    await writeFile(path.join(shared, "keep.txt"), "keep");
    mgr.registerLink(await materialize("link", shared, wt.dir));
    expect(existsSync(path.join(wt.dir, "node_modules", "keep.txt"))).toBe(true);
    expect(await worktreeCount()).toBe(2);
    expect(await mgr.cleanupAll()).toBe(true);
    expect(existsSync(wt.dir)).toBe(false);
    expect(existsSync(path.join(shared, "keep.txt"))).toBe(true);
    expect(await worktreeCount()).toBe(1);
    expect(await workingTreeChecksum(repo.dir)).toBe(before);
    expect(await repo.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    await rm(shared, { recursive: true, force: true });
  });

  it("checksum detects working-tree edits", async () => {
    const a = await workingTreeChecksum(repo.dir);
    await writeFile(path.join(repo.dir, "notes.txt"), "changed");
    expect(await workingTreeChecksum(repo.dir)).not.toBe(a);
  });
});

describe("install planning", () => {
  it("hashes lockfiles (EOL-normalised) and reuses the repo node_modules via a link when the hash matches", async () => {
    const wt = await mkdtemp(path.join(os.tmpdir(), "sw-wt-"));
    try {
      await writeFile(path.join(repo.dir, "package.json"), "{}");
      await writeFile(path.join(repo.dir, "package-lock.json"), '{"a":1}\n');
      await mkdir(path.join(repo.dir, "node_modules"));
      await writeFile(path.join(wt, "package.json"), "{}");
      await writeFile(path.join(wt, "package-lock.json"), '{"a":1}\r\n');
      expect((await lockInfo(wt))?.hash).toBe((await lockInfo(repo.dir))?.hash);
      const cache = new Map<string, string>();
      const a = await planInstall({
        worktree: wt,
        strategy: "link",
        sandbox: "process",
        repo: repo.dir,
        cache,
      });
      expect(a).toMatchObject({ kind: "link", source: path.join(repo.dir, "node_modules") });
      const d = await planInstall({
        worktree: wt,
        strategy: "link",
        sandbox: "docker",
        repo: repo.dir,
        cache,
      });
      expect(d.kind).toBe("install"); // host node_modules never reused in docker
      await writeFile(path.join(wt, "package-lock.json"), '{"a":2}');
      const b = await planInstall({
        worktree: wt,
        strategy: "link",
        sandbox: "process",
        repo: repo.dir,
        cache,
      });
      expect(b).toMatchObject({ kind: "install", command: ["npm", "ci", "--no-audit", "--no-fund"] });
      expect(
        (
          await planInstall({
            worktree: repo.dir,
            strategy: "none",
            sandbox: "process",
            repo: repo.dir,
            cache,
          })
        ).kind,
      ).toBe("skip");
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("parses git shortstat", () => {
    expect(parseShortStat(" 2 files changed, 10 insertions(+), 3 deletions(-)")).toMatchObject({
      files: 2,
      insertions: 10,
      deletions: 3,
      lines: 13,
    });
    expect(parseShortStat(" 1 file changed, 1 deletion(-)")).toMatchObject({
      files: 1,
      insertions: 0,
      deletions: 1,
    });
  });
});

describe("runEvolution gates (stubbed benchmark)", () => {
  const base = () => ({
    repo: repo.dir,
    start: [process.execPath, "server.mjs"],
    health: "/healthz",
    test: [process.execPath, "test.mjs"],
    workload: { vus: 1, duration: "200ms" },
    metrics: ["p95"],
    design: { repetitions: 2 },
    bootstrap: 200,
    sandbox: { kind: "process" as const },
  });

  it("rejects a candidate whose test command fails; working tree unchanged; worktrees removed", async () => {
    const before = await workingTreeChecksum(repo.dir);
    const res = await runEvolution(
      { ...base(), candidates: ["branch:fix/fast", "branch:fix/broken"] },
      { safety: approved() },
      { runWorkload: stubWorkload },
    );
    const d = res.data!;
    const broken = d.candidates.find((c) => c.name === "fix/broken")!;
    expect(broken.status).toBe("rejected");
    expect(broken.rejectionReasons.join(" ")).toMatch(/test.*exit code 1.*1 test failed/);
    expect(d.candidates.find((c) => c.name === "fix/fast")!.status).toBe("accepted");
    expect(d.rejected.map((r) => r.name)).toEqual(["fix/broken"]);
    expect(d.workingTree.unchanged).toBe(true);
    expect(await workingTreeChecksum(repo.dir)).toBe(before);
    expect(d.worktreesCleaned).toBe(true);
    expect(await worktreeCount()).toBe(1);
    expect(broken.diff.files).toBe(2);
  }, 60_000);

  it("patch candidates are applied inside the worktree only; a non-applying patch is rejected", async () => {
    const patch = path.join(repo.dir, "..", `fast-${path.basename(repo.dir)}.diff`);
    const bad = path.join(repo.dir, "..", `bad-${path.basename(repo.dir)}.diff`);
    await writeFile(patch, await repo.git("diff", "main", "fix/fast"));
    await writeFile(
      bad,
      "diff --git a/nope.txt b/nope.txt\n--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-x\n+y\n",
    );
    try {
      const res = await runEvolution(
        { ...base(), candidates: [`patch:${patch}`, `patch:${bad}`] },
        { safety: approved() },
        { runWorkload: stubWorkload },
      );
      const d = res.data!;
      const good = d.candidates.find((c) => c.kind === "patch" && c.name.startsWith("fast"))!;
      expect(good.status).toBe("accepted");
      expect(good.diff.files).toBe(1);
      expect(d.candidates.find((c) => c.name.startsWith("bad"))!.rejectionReasons.join(" ")).toMatch(
        /patch does not apply/,
      );
      expect(JSON.parse(await readFile(path.join(repo.dir, "delay.json"), "utf8"))).toEqual({ delayMs: 40 });
      expect(d.workingTree.unchanged).toBe(true);
    } finally {
      await rm(patch, { force: true });
      await rm(bad, { force: true });
    }
  }, 60_000);

  it("abort mid-run: cancelled, worktrees cleaned, working tree unchanged", async () => {
    const ac = new AbortController();
    const before = await workingTreeChecksum(repo.dir);
    const res = await runEvolution(
      { ...base(), candidates: ["branch:fix/fast", "branch:fix/slower"] },
      { safety: approved(), signal: ac.signal },
      {
        runWorkload: async (input) => {
          ac.abort();
          return { ...fakeResult(String(input.target), { p95: 50 }), status: "cancelled" };
        },
      },
    );
    expect(res.status).toBe("cancelled");
    expect(res.data!.worktreesCleaned).toBe(true);
    expect(await worktreeCount()).toBe(1);
    expect(await workingTreeChecksum(repo.dir)).toBe(before);
  }, 60_000);

  it("auto sandbox without Docker → skipped with a limitation; process sandbox needs approval", async () => {
    const res = await runEvolution(
      { ...base(), sandbox: { kind: "auto" }, candidates: ["branch:fix/fast"] },
      {},
      { dockerCheck: async () => ({ ok: false, reason: "daemon down" }) },
    );
    expect(res.status).toBe("skipped");
    expect(res.limitations[0]?.code).toBe("EVOLUTION-NO-SANDBOX");
    await expect(
      runEvolution({ ...base(), candidates: ["branch:fix/fast"] }, {}, { runWorkload: stubWorkload }),
    ).rejects.toThrow(/requires approval/);
    expect(await worktreeCount()).toBe(1);
  }, 30_000);

  it("regression replays reject only new reproductions vs the baseline", async () => {
    const res = await runEvolution(
      {
        ...base(),
        candidates: ["branch:fix/fast", "branch:fix/slower"],
        test: undefined,
        replays: { artifacts: ["a.json"] },
      },
      { safety: approved() },
      {
        runWorkload: stubWorkload,
        replay: async ({ url }) => {
          const body = await fetch(`${url}/healthz`).then((r) => r.text());
          expect(body).toBe("ok");
          // pretend fix/slower (identified by its port order: 3rd start) reintroduces the bug
          calls++;
          return { fingerprint: "fp", reproduced: calls === 3 };
        },
      },
    );
    expect(res.data!.candidates.find((c) => c.name === "fix/slower")!.rejectionReasons.join(" ")).toMatch(
      /reintroduces a\.json/,
    );
    expect(res.data!.candidates.find((c) => c.name === "fix/fast")!.status).toBe("accepted");
  }, 60_000);
});

let calls = 0;
