/**
 * User-, config- and target-caused conditions in the experiment engines must not end as exit 70
 * ("bug in SECOND WORLD"). docs/09-cli-and-api.md exit codes; docs/03-engines/experiments.md §A/§B.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import type { RunningApp } from "../../../src/engines/experiments/app.js";
import { runEvolution, runExperiment, type WorkloadRunner } from "../../../src/engines/experiments/index.js";
import { computeVerdict } from "../../../src/engines/reporting/model.js";
import { fakeResult } from "../../fixtures/experiments/fake-perf.js";
import { createTempRepo, type TempRepo } from "../../fixtures/experiments/git-repo.js";

const approved = () => createSafetyGuard({}, { interactive: false, approve: true });
const evo = (repo: string, extra: Record<string, unknown> = {}) => ({
  repo,
  candidates: ["branch:fix/fast"],
  start: [process.execPath, "server.mjs"],
  sandbox: { kind: "process" as const },
  ...extra,
});

describe("evolution: wrong repo / ref are config errors (exit 2)", () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({ dirty: false });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it("repo path that does not exist", async () => {
    const p = runEvolution(evo(path.join(repo.dir, "nope", "missing")), { safety: approved() });
    await expect(p).rejects.toBeInstanceOf(ConfigError);
  });

  it("directory that is not a git repository", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sw-not-a-repo-"));
    try {
      await expect(runEvolution(evo(dir), { safety: approved() })).rejects.toMatchObject({
        code: "SW_CONFIG_EVOLUTION_REPO",
        exitCode: 2,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("baseline ref that does not resolve", async () => {
    await expect(
      runEvolution(evo(repo.dir, { baseline: "no-such-ref" }), { safety: approved() }),
    ).rejects.toMatchObject({
      code: "SW_CONFIG_EVOLUTION_REF",
      exitCode: 2,
    });
  });

  it("baseline whose own build fails: target-side (exit 5), not 70", async () => {
    const res = await runEvolution(evo(repo.dir, { build: [process.execPath, "-e", "process.exit(1)"] }), {
      safety: approved(),
    });
    expect(res.status).toBe("error");
    expect(res.limitations.find((l) => l.code === "EVOLUTION-BASELINE-FAILED")?.impact).toBe("invalidates");
    expect(computeVerdict([res]).exitCode).toBe(5);
  }, 60_000);
});

const fakeApp = async (): Promise<RunningApp> => ({
  url: "http://127.0.0.1:40999",
  port: 40999,
  pid: undefined,
  argv: [],
  output: () => "",
  stop: async () => undefined,
  exited: false,
});

describe("what-if: user/target conditions", () => {
  it("an arm without start command or target is a config error (exit 2)", async () => {
    await expect(
      runExperiment({
        name: "x",
        baseline: {},
        variants: [{ name: "v", env: { V: "1" } }],
        workload: { scenarios: [{ name: "w", steps: [{ path: "/" }] }] },
        design: { repetitions: 2 },
      }),
    ).rejects.toMatchObject({ code: "SW_CONFIG_WHATIF_NO_TARGET", exitCode: 2 });
  });

  it("every run failed (nothing measured): exit 5, not 70", async () => {
    const runWorkload: WorkloadRunner = async (input) => ({
      ...fakeResult(String(input.target), { p95: 50 }),
      status: "error",
      data: undefined,
      limitations: [{ code: "target-unreachable", message: "connection refused", impact: "invalidates" }],
    });
    const res = await runExperiment(
      {
        name: "all-fail",
        baseline: { start: "node app.js" },
        variants: [{ name: "v", env: { V: "1" } }],
        metrics: ["p95"],
        design: { repetitions: 2, seed: 1 },
        bootstrap: 200,
      },
      {},
      { runWorkload, startApp: fakeApp },
    );
    expect(res.status).toBe("error");
    expect(computeVerdict([res]).exitCode).toBe(5);
  });
});
