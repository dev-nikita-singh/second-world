/**
 * Suspicion 1c (PLAN-wave8 §sw-robust-w8): parallel runs sharing one `-o` dir. Each report file is
 * always complete (atomic rename), but the SET of files could come from different runs
 * (report.json of run A next to report.md of run B). finishRun now writes the whole set under a
 * directory lock `<outDir>/.sw-report.lock`, so one dir holds one run's reports (the last run to
 * finish). docs/02-architecture.md §4.6.
 */
import { readdir, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishRun } from "../../../src/cli/run-common.js";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import type { World } from "../../../src/core/world.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir;
beforeEach(async () => {
  tmp = await makeTmpDir("sw-sharedout-");
});
afterEach(async () => {
  process.exitCode = undefined;
  await tmp.cleanup();
});

function result(runId: string, endpoints: number): EngineResult {
  const iso = new Date().toISOString();
  return {
    schemaVersion: 1,
    engine: "performance",
    runId,
    status: "passed",
    startedAt: iso,
    endedAt: iso,
    findings: [],
    limitations: [],
    artifacts: [],
    data: {
      latency: { corrected: { mean: 1, p50: 1, p90: 2, p95: 2, p99: 3, max: 4 } },
      totals: { rps: 100, errorRate: 0, requests: 1000 },
      // different sizes so the two runs' writes take different times
      endpoints: Array.from({ length: endpoints }, (_, i) => ({ name: `GET /e${i}`, requests: 10 })),
    },
  } as unknown as EngineResult;
}

function world(outDir: string): World {
  return {
    config: {
      cwd: tmp.path,
      config: { report: { outDir, formats: ["json", "md", "junit", "sarif", "html"], failOn: "never" } },
    },
    history: { save: async () => null },
  } as unknown as World;
}

describe("two runs writing reports into one -o dir", () => {
  it("every file of the dir comes from the same run (30 rounds)", async () => {
    const mixed: string[] = [];
    for (let round = 0; round < 30; round++) {
      const out = tmp.join(`o${round}`);
      const a = `RUNA${round}X`;
      const b = `RUNB${round}X`;
      await Promise.all([
        finishRun(world(out), result(a, 2000), { quiet: true } as never, {
          label: "t",
          history: false,
          suppressStdout: true,
        }),
        finishRun(world(out), result(b, 5), { quiet: true } as never, {
          label: "t",
          history: false,
          suppressStdout: true,
        }),
      ]);
      const owners = new Set<string>();
      for (const f of (await readdir(out)).filter((n) => n.startsWith("report."))) {
        const text = await readFile(`${out}/${f}`, "utf8");
        owners.add(text.includes(a) ? "A" : text.includes(b) ? "B" : "?");
      }
      if (owners.size !== 1) mixed.push(`round ${round}: ${[...owners].join("+")}`);
    }
    expect(mixed).toEqual([]);
  }, 120_000);
});
