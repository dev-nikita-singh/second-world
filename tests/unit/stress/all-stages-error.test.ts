/**
 * Every stage ends with status "error": the verdict must say why (target → 5, Safety Guard → 3)
 * instead of falling through to an engine error (70). Instant failures must not hide behind a
 * generator-saturation verdict. docs/03-engines/stress-capacity-lab.md §7.
 */
import { describe, expect, it } from "vitest";
import type { EngineResult, Limitation } from "../../../src/core/evidence/schemas.js";
import type { PerformanceData } from "../../../src/engines/performance/types.js";
import { computeVerdict } from "../../../src/engines/reporting/model.js";
import { runStress, type StageRunner } from "../../../src/engines/stress/index.js";
import { allErroredLimitations } from "../../../src/engines/stress/runner.js";

const T = "http://127.0.0.1:1/";

function perfResult(
  status: EngineResult["status"],
  limitations: Limitation[],
  totals: { requests: number; ok: number; failed: number },
  saturated = false,
): EngineResult<PerformanceData> {
  const data = {
    totals: {
      ...totals,
      errorRate: totals.requests > 0 ? totals.failed / totals.requests : 0,
      rps: totals.requests,
    },
    latency: { corrected: { mean: 1, p50: 1, p90: 1, p95: 1, p99: 1, max: 1 } },
    generator: {
      saturated,
      reasons: saturated ? ["generator CPU 119% > 85% of one core"] : [],
      cpuPercent: saturated ? 119 : 1,
      eventLoopDelayP99Ms: 1,
      meanInFlight: 1,
    },
    series: [],
    histograms: { unit: "us", global: { corrected: "", raw: "" }, endpoints: {} },
    window: { measuredMs: 1000 },
    thresholds: [],
  } as unknown as PerformanceData;
  return {
    schemaVersion: 1,
    engine: "performance",
    runId: "p",
    status,
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(0).toISOString(),
    findings: [],
    limitations,
    artifacts: [],
    data,
  };
}

const runner =
  (mk: () => EngineResult<PerformanceData>): StageRunner =>
  async () =>
    mk();

const NO_MEAS: Limitation = { code: "no-measurements", message: "none", impact: "invalidates" };
const UNREACH: Limitation = { code: "target-unreachable", message: "refused", impact: "invalidates" };

describe("stress: every stage errors", () => {
  it("every request times out (perf no-measurements) → no-measurements limitation, exit 5", async () => {
    const r = await runStress(
      { target: T, stages: [2, 4], hold: "1s" },
      {},
      { runStage: runner(() => perfResult("error", [NO_MEAS], { requests: 0, ok: 0, failed: 0 })) },
    );
    expect(r.status).toBe("error");
    const lim = r.limitations.find((l) => l.code === "no-measurements");
    expect(lim?.impact).toBe("invalidates");
    expect(lim?.message).toMatch(/timeout/);
    expect(computeVerdict([r]).exitCode).toBe(5);
  });

  it("connection refused on every stage keeps target-unreachable, exit 5", async () => {
    const r = await runStress(
      { target: T, stages: [2], hold: "1s" },
      {},
      { runStage: runner(() => perfResult("error", [UNREACH], { requests: 5, ok: 0, failed: 5 })) },
    );
    expect(r.limitations.map((l) => l.code)).toContain("target-unreachable");
    expect(computeVerdict([r]).exitCode).toBe(5);
  });

  it("DNS rebinding stop on the only stage is surfaced as a safety limitation, exit 3", async () => {
    const rebind: Limitation = {
      code: "dns-rebind",
      message: "host now resolves to 10.0.0.1",
      impact: "invalidates",
    };
    const r = await runStress(
      { target: T, stages: [2], hold: "1s" },
      {},
      { runStage: runner(() => perfResult("error", [rebind, NO_MEAS], { requests: 0, ok: 0, failed: 0 })) },
    );
    expect(r.limitations.map((l) => l.code)).toContain("dns-rebind");
    expect(computeVerdict([r]).exitCode).toBe(3);
  });

  it("a stage error with no target-side cause stays an engine error (70)", async () => {
    const r = await runStress(
      { target: T, stages: [2], hold: "1s" },
      {},
      { runStage: runner(() => perfResult("error", [], { requests: 10, ok: 10, failed: 0 })) },
    );
    expect(r.status).toBe("error");
    expect(r.limitations.some((l) => l.code === "no-measurements" || l.code === "target-unreachable")).toBe(
      false,
    );
    expect(computeVerdict([r]).exitCode).toBe(70);
  });

  it("thrown internal exceptions are not swallowed", async () => {
    await expect(
      runStress(
        { target: T, stages: [2], hold: "1s" },
        {},
        {
          runStage: async () => {
            throw new TypeError("boom");
          },
        },
      ),
    ).rejects.toThrow("boom");
  });

  it("every request failing instantly is a breach, not generator saturation (exit 1, not 0)", async () => {
    const r = await runStress(
      { target: T, stages: [2, 4], hold: "1s" },
      {},
      { runStage: runner(() => perfResult("passed", [], { requests: 500, ok: 0, failed: 500 }, true)) },
    );
    expect(r.data!.invalidFromStage).toBeNull();
    expect(r.data!.stages[0]!.generator.saturated).toBe(false);
    expect(r.data!.firstBreach).not.toBeNull();
    expect(r.status).toBe("failed");
    expect(computeVerdict([r]).exitCode).toBe(1);
  });

  it("allErroredLimitations: mixed causes (one stage without a target-side code) → []", () => {
    expect(allErroredLimitations([[NO_MEAS], []], T, false)).toEqual([]);
    expect(allErroredLimitations([[NO_MEAS], [UNREACH]], T, false)[0]?.code).toBe("no-measurements");
    expect(allErroredLimitations([[UNREACH]], T, true)[0]?.code).toBe("target-unreachable");
  });
});
