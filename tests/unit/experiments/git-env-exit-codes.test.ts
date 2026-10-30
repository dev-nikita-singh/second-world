/**
 * Git / worktree failures in the Evolution engine are environment or repository problems, never a bug
 * in SECOND WORLD: repo/ref/config → ConfigError (exit 2), git or filesystem refusing → CapabilityError
 * (exit 4). docs/03-engines/experiments.md §B.3; docs/09-cli-and-api.md exit codes.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityError, ConfigError, ExitCode } from "../../../src/core/errors.js";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import { type GitResult, gitFailure, gitOk } from "../../../src/engines/experiments/git.js";
import { runEvolution } from "../../../src/engines/experiments/index.js";
import { WorktreeManager } from "../../../src/engines/experiments/worktree.js";
import { createTempRepo, type TempRepo } from "../../fixtures/experiments/git-repo.js";

const res = (stderr: string, extra: Partial<GitResult> = {}): GitResult => ({
  stdout: "",
  stderr,
  exitCode: 128,
  ...extra,
});

describe("gitFailure classification", () => {
  const cases: [string, number, RegExp][] = [
    [
      "fatal: could not create leading directories of '.git/worktrees/x': Permission denied",
      4,
      /permissions/,
    ],
    ["error: unable to create file a/b/c.txt: Filename too long", 4, /core\.longpaths true/],
    ["fatal: Unable to create '/r/.git/index.lock': File exists.", 4, /lock/],
    ["fatal: '/tmp/x' is a missing but already registered worktree", 4, /git worktree prune/],
    ["error: unable to write file: No space left on device", 4, /disk space/],
    ["fatal: detected dubious ownership in repository at '/r'", 2, /safe\.directory/],
    ["fatal: invalid reference: deadbeef", 2, /rev-parse --verify/],
    ["fatal: .git/index: index file smaller than expected", 2, /git status/],
  ];
  for (const [stderr, exit, hint] of cases) {
    it(`${stderr.slice(0, 50)} → exit ${exit}`, () => {
      const e = gitFailure("git x", res(stderr));
      expect(e.exitCode).toBe(exit);
      expect(e.hint).toMatch(hint);
      expect(e.message).toContain(stderr.slice(0, 30));
    });
  }

  it("unmatched stderr uses the fallback; message is short and trimmed", () => {
    const long = `fatal: something odd\n${"x".repeat(2000)}\n`;
    expect(gitFailure("git a", res(long)).exitCode).toBe(ExitCode.ConfigInvalid);
    const e = gitFailure("git a", res(long), "capability");
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.message.length).toBeLessThan(500);
    expect(e.message).not.toContain("\n");
  });

  it("timeout → capability", () => {
    const e = gitFailure("git status", res("", { exitCode: -1, timedOut: true }));
    expect(e.code).toBe("SW_CAP_GIT_TIMEOUT");
    expect(e.exitCode).toBe(4);
  });
});

describe("git helpers and worktrees against a real repository", () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({ dirty: false });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it("gitOk: non-zero git exit is a ConfigError, not an EngineError (was exit 70)", async () => {
    await expect(gitOk(repo.dir, ["rev-parse", "--verify", "no-such-ref-xyz"])).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("worktree add of a commit git does not know → ConfigError with git's stderr", async () => {
    const mgr = new WorktreeManager(repo.dir);
    try {
      await expect(mgr.add("x", "0123456789abcdef0123456789abcdef01234567")).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringMatching(/invalid reference/),
      });
    } finally {
      await mgr.cleanupAll();
    }
  });

  it("worktree add refused by the filesystem → CapabilityError (exit 4)", async () => {
    // .git/worktrees as a regular file: git cannot create the worktree's admin directory.
    await writeFile(path.join(repo.dir, ".git", "worktrees"), "x");
    const mgr = new WorktreeManager(repo.dir);
    try {
      await expect(mgr.add("x", await repo.git("rev-parse", "HEAD"))).rejects.toMatchObject({
        exitCode: 4,
        code: "SW_CAP_EVOLUTION_GIT",
      });
    } finally {
      await mgr.cleanupAll();
      await rm(path.join(repo.dir, ".git", "worktrees"), { force: true });
    }
  });

  it("temp directory that does not exist → ConfigError SW_CONFIG_EVOLUTION_TMPDIR", async () => {
    const mgr = new WorktreeManager(repo.dir, path.join(repo.dir, "no", "such", "tmp"));
    await expect(mgr.add("x", "HEAD")).rejects.toMatchObject({
      code: "SW_CONFIG_EVOLUTION_TMPDIR",
      exitCode: 2,
    });
  });
});

describe("sw evolve end to end: environment failures map to 2 / 4", () => {
  let repo: TempRepo;
  let tmp: string;
  beforeEach(async () => {
    repo = await createTempRepo({ dirty: false });
    tmp = await mkdtemp(path.join(os.tmpdir(), "sw-evo-tmp-"));
  });
  afterEach(async () => {
    await rm(path.join(repo.dir, ".git", "worktrees"), { force: true, recursive: true });
    await repo.cleanup();
    await rm(tmp, { recursive: true, force: true });
  });
  const input = (extra: Record<string, unknown> = {}) => ({
    repo: repo.dir,
    candidates: ["branch:fix/fast"],
    start: [process.execPath, "server.mjs"],
    sandbox: { kind: "process" as const },
    tmpDir: tmp,
    ...extra,
  });
  const approved = () => createSafetyGuard({}, { interactive: false, approve: true });

  it("baseline worktree cannot be created → CapabilityError (exit 4), temp dir cleaned", async () => {
    await writeFile(path.join(repo.dir, ".git", "worktrees"), "x");
    const err = await runEvolution(input(), { safety: approved() }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).exitCode).toBe(4);
    expect((err as CapabilityError).message).toMatch(/worktree add \(baseline\)/);
    // no sw-evo-* parent left behind
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(tmp)).filter((n) => n.startsWith("sw-evo-"))).toEqual([]);
  }, 60_000);

  it("tmpDir that does not exist → ConfigError (exit 2)", async () => {
    const missing = path.join(tmp, "missing");
    await expect(runEvolution(input({ tmpDir: missing }), { safety: approved() })).rejects.toMatchObject({
      exitCode: 2,
      code: "SW_CONFIG_EVOLUTION_TMPDIR",
    });
    expect(existsSync(missing)).toBe(false);
  }, 60_000);

  it("corrupt index (git status fails) → ConfigError (exit 2), not 70", async () => {
    await writeFile(path.join(repo.dir, ".git", "index"), "garbagegarbage");
    await expect(runEvolution(input(), { safety: approved() })).rejects.toMatchObject({
      exitCode: 2,
      code: "SW_CONFIG_EVOLUTION_GIT",
    });
  }, 60_000);
});
