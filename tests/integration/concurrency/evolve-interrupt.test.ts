/**
 * Ctrl+C during `sw evolve` (Plan wave 7 §A; docs/03-engines/experiments.md §B.3 "every worktree is
 * removed on success, error and abort"): exit 130, no git worktree, no temp checkout dir and no
 * candidate app process left behind.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempRepo, type TempRepo } from "../../fixtures/experiments/git-repo.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";
import { pidAlive, sw } from "./helpers.js";

let repo: TempRepo;
let aux: TmpDir;

beforeEach(async () => {
  repo = await createTempRepo({ dirty: false });
  aux = await makeTmpDir("sw-evo-int-");
  writeFileSync(path.join(repo.dir, ".gitignore"), ".second-world/\n");
});
afterEach(async () => {
  // never leave app processes behind, even when an assertion failed
  const pids = path.join(aux.path, "pids");
  if (existsSync(pids))
    for (const f of readdirSync(pids)) {
      try {
        process.kill(Number(f), "SIGKILL");
      } catch {
        // gone
      }
    }
  await repo.cleanup();
  await aux.cleanup();
});

describe("sw evolve interrupted", () => {
  it("Ctrl+C while a candidate app runs → exit 130, worktrees removed, app processes gone", async () => {
    const pids = path.join(aux.path, "pids");
    const wtRoot = path.join(aux.path, "wt");
    mkdirSync(pids);
    mkdirSync(wtRoot);
    // the candidate app: records its pid, then serves /healthz and /work forever
    const app = path.join(aux.path, "app.mjs");
    writeFileSync(
      app,
      `import http from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
writeFileSync(path.join(${JSON.stringify(pids)}, String(process.pid)), "");
http.createServer((req, res) => setTimeout(() => res.end("ok"), 5)).listen(Number(process.env.PORT ?? 0), process.env.HOST ?? "127.0.0.1");
`,
    );
    writeFileSync(
      path.join(repo.dir, "sw.config.json"),
      JSON.stringify({
        targets: { api: { url: "http://127.0.0.1:1" } },
        safety: { allowHosts: ["127.0.0.1"] },
        evolution: {
          tmpDir: wtRoot,
          readyWhen: { path: "/healthz", timeout: "10s", interval: 100 },
          workload: { vus: 2, duration: "5s", scenarios: [{ name: "w", steps: [{ path: "/work" }] }] },
        },
      }),
    );
    const r = await sw(
      [
        "--yes",
        "evolve",
        "--candidates",
        "branch:fix/fast,branch:fix/slower",
        "--sandbox",
        "process",
        "--start",
        `node ${app.split(path.sep).join("/")}`,
        "--health",
        "/healthz",
        "--repetitions",
        "5",
        "--no-history",
      ],
      {
        cwd: repo.dir,
        env: { SW_USER_CONFIG_DIR: aux.path, SW_TEST_SIGINT_WHEN_FILE: path.join(pids, "*") },
        timeoutMs: 120_000,
      },
    );
    expect(readdirSync(pids).length, r.stderr.slice(-1500)).toBeGreaterThan(0);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(130);
    expect(r.mainReturned && !r.timedOut).toBe(true);
    expect((await repo.git("worktree", "list")).split("\n")).toHaveLength(1);
    expect(readdirSync(wtRoot)).toEqual([]);
    for (const p of readdirSync(pids)) expect(pidAlive(Number(p)), `app pid ${p}`).toBe(false);
    expect(readFileSync(path.join(repo.dir, "delay.json"), "utf8")).toContain("40"); // user tree untouched
  }, 180_000);
});
