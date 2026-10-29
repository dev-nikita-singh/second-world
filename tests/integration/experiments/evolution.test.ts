/**
 * Evolution end-to-end on a temp git repo with a tiny HTTP app (no dependencies):
 * fix/fast (faster) must be on the Pareto front, fix/broken (failing test) rejected, fix/slower
 * not on the front, and the user's (dirty) working tree must stay byte-identical.
 * Docker sandbox variant runs only when Docker is reachable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import {
  dockerReachable,
  runEvolution,
  workingTreeChecksum,
} from "../../../src/engines/experiments/index.js";
import { createTempRepo, type TempRepo } from "../../fixtures/experiments/git-repo.js";

const docker = (await dockerReachable(8000)).ok;

let repo: TempRepo;
beforeEach(async () => {
  repo = await createTempRepo();
});
afterEach(async () => {
  await repo?.cleanup();
});

const common = () => ({
  repo: repo.dir,
  candidates: ["branch:fix/fast", "branch:fix/broken", "branch:fix/slower"],
  health: "/healthz",
  workload: {
    vus: 2,
    duration: "800ms",
    warmup: "200ms",
    scenarios: [{ name: "w", steps: [{ path: "/work" }] }],
  },
  metrics: ["p50", "p95", "rps"],
  success: { p95: { improvement: ">= 15%" } },
  design: { repetitions: 5, seed: 5 },
});

describe("Evolution (process sandbox)", () => {
  it("ranks the faster branch on the Pareto front, rejects the broken one, leaves the working tree unchanged", async () => {
    const before = await workingTreeChecksum(repo.dir);
    const res = await runEvolution(
      {
        ...common(),
        start: [process.execPath, "server.mjs"],
        test: [process.execPath, "test.mjs"],
        sandbox: { kind: "process" },
      },
      { safety: createSafetyGuard({}, { interactive: false, approve: true }) },
    );
    const d = res.data!;
    console.log(
      d.candidates
        .map(
          (c) =>
            `${c.name} ${c.status} rank=${c.rank ?? "-"} pareto=${c.pareto} p95=${c.medians.p95?.toFixed(2)} ${JSON.stringify(c.verdicts)} ${c.rejectionReasons.join("; ")}`,
        )
        .join("\n"),
    );
    expect(res.status).toBe("passed");
    expect(d.paretoFront).toEqual(["fix/fast"]);
    const fast = d.candidates.find((c) => c.name === "fix/fast")!;
    expect(fast.verdicts.p95).toBe("improved");
    expect(fast.rank).toBe(1);
    expect(d.rejected).toEqual([{ name: "fix/broken", reasons: [expect.stringMatching(/test/)] }]);
    const slower = d.candidates.find((c) => c.name === "fix/slower")!;
    expect(slower.pareto).toBe(false);
    expect(slower.verdicts.p95).toBe("regressed");
    expect(d.workingTree.unchanged).toBe(true);
    expect(await workingTreeChecksum(repo.dir)).toBe(before);
    expect(d.worktreesCleaned).toBe(true);
    expect(res.findings.map((f) => f.ruleId)).toEqual(["EVOLUTION-PARETO-CANDIDATE"]);
  }, 90_000);
});

describe.skipIf(!docker)("Evolution (docker sandbox)", () => {
  it("runs gates and the app inside containers with identical limits", async () => {
    const res = await runEvolution({
      ...common(),
      candidates: ["branch:fix/fast", "branch:fix/broken"],
      design: { repetitions: 3 },
      start: ["node", "server.mjs"],
      test: ["node", "test.mjs"],
      sandbox: { kind: "docker", cpus: 1, memory: "256m" },
      readyWhen: { path: "/healthz", timeout: "60s" },
    });
    const d = res.data!;
    expect(d.sandbox.kind).toBe("docker");
    expect(d.rejected.map((r) => r.name)).toEqual(["fix/broken"]);
    expect(d.workingTree.unchanged).toBe(true);
  }, 180_000);
});
