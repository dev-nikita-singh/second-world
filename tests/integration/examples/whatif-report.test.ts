/**
 * Real sanity check: a short What-If A/A run (r = 2) against the calibrated server in a child
 * process, rendered in every report format.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { runExperiment } from "../../../src/engines/experiments/index.js";
import type { ExperimentData } from "../../../src/engines/experiments/types.js";
import { isExperimentData } from "../../../src/engines/reporting/experiments.js";
import { REPORT_FORMATS, renderReport, writeReports } from "../../../src/engines/reporting/index.js";
import {
  type ChildCalibratedServer,
  startCalibratedServerInChild,
} from "../../fixtures/servers/calibrated-child.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let srv: ChildCalibratedServer;
let result: EngineResult<ExperimentData>;
let tmp: TmpDir;

beforeAll(async () => {
  srv = await startCalibratedServerInChild();
  tmp = await makeTmpDir("sw-whatif-report-");
  result = await runExperiment({
    name: "aa-render",
    mode: "aa",
    baseline: { target: srv.url },
    workload: {
      vus: 2,
      duration: "600ms",
      warmup: "200ms",
      scenarios: [{ name: "f", steps: [{ path: "/fixed/5" }] }],
    },
    metrics: ["p50", "p95"],
    design: { repetitions: 2, order: "randomized-blocks", seed: 3 },
  });
}, 60_000);

afterAll(async () => {
  await srv?.close();
  await tmp?.cleanup();
});

describe("What-If A/A result rendered in every format", () => {
  it("produced real ExperimentData", () => {
    expect(isExperimentData(result.data)).toBe(true);
    expect(result.data!.mode).toBe("aa");
    expect(result.data!.comparisons.length).toBe(2);
    expect(result.data!.runs.length).toBe(4);
  });

  it("renders all formats", async () => {
    for (const fmt of REPORT_FORMATS) {
      const out = renderReport([result], fmt, { color: false });
      expect(out.length, fmt).toBeGreaterThan(200);
    }
    const s = renderReport([result], "tty", { color: false });
    expect(s).toContain("A/A (baseline vs itself: noise floor)");
    expect(s).toContain("Verdicts per metric");
    expect(s).toContain("Noise floor (A/A)");
    const xml = renderReport([result], "junit");
    expect([...xml.matchAll(/<testcase name="A\/A: /g)]).toHaveLength(2);
    const { files } = await writeReports([result], { formats: [...REPORT_FORMATS], outDir: tmp.path });
    expect(files).toHaveLength(5);
  });
});
