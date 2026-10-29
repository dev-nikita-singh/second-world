/** Synthetic Performance Lab stage results for stress unit tests (no network). */
import {
  evaluateThreshold,
  parseThresholds,
  type ThresholdSpec,
} from "../../../src/core/config/thresholds.js";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import type { PerformanceData } from "../../../src/engines/performance/types.js";
import type { StageRunner } from "../../../src/engines/stress/index.js";
import type { StageResult } from "../../../src/engines/stress/types.js";

export interface FakeModel {
  /** p95 (ms) at this level. */
  p95(level: number): number;
  errorRate?(level: number): number;
  throughput?(level: number): number;
  saturated?(level: number): boolean;
  /** Safety rate cap in req/s: throughput is clamped to it and the stage carries PERF-THROTTLED-BY-SAFETY. */
  capRps?: number;
  /** Per-window p95 series for a stage (seconds → ms). */
  series?(level: number, holdS: number, stageIdx: number): number[];
}

let n = 0;

export function fakeRunner(model: FakeModel, calls: Record<string, unknown>[] = []): StageRunner {
  return async (input) => {
    calls.push(input);
    const level = (input.vus ?? input.rate) as number;
    const holdS = Math.max(1, Math.round((input.duration as number) / 1000));
    const p95 = model.p95(level);
    const er = model.errorRate?.(level) ?? 0;
    const thr = parseThresholds((input.thresholds ?? {}) as Record<string, ThresholdSpec>);
    const thresholds = thr.map((t) => {
      const actual = t.stat === "error_rate" ? er : t.stat === "p99" ? p95 * 1.2 : p95;
      return {
        expression: t.source,
        metric: t.metric,
        op: t.op,
        threshold: t.value,
        unit: t.unit ?? "ms",
        actual,
        passed: evaluateThreshold(t, actual),
        abortOnFail: false,
      };
    });
    const seriesP95 =
      model.series?.(level, holdS, calls.length - 1) ?? Array.from({ length: holdS }, () => p95);
    const uncappedRps = model.throughput?.(level) ?? level * 10;
    const isCapped = model.capRps !== undefined && uncappedRps > model.capRps;
    const rps = isCapped ? (model.capRps as number) : uncappedRps;
    const requests = Math.round(rps * holdS);
    const data = {
      schema: 1,
      target: input.target,
      totals: {
        requests,
        ok: requests,
        failed: Math.round(requests * er),
        errorRate: er,
        rps,
        ...(isCapped ? { throttled: requests } : {}),
      },
      latency: {
        corrected: {
          count: requests,
          min: 1,
          mean: p95 / 2,
          stdDev: 1,
          p50: p95 / 2,
          p75: p95,
          p90: p95,
          p95,
          p99: p95 * 1.2,
          p999: p95 * 1.5,
          max: p95 * 2,
        },
      },
      generator: {
        saturated: model.saturated?.(level) ?? false,
        reasons: model.saturated?.(level) ? ["event loop delay p99 high"] : [],
        cpuPercent: 10,
        eventLoopDelayP99Ms: 1,
        meanInFlight: level,
      },
      series: seriesP95.map((p, i) => ({
        t: i,
        requests: Math.round(rps),
        ok: 1,
        failed: 0,
        rps,
        bytesIn: 0,
        p50: p / 2,
        p95: p,
        p99: p,
        max: p,
      })),
      histograms: { unit: "us", global: { corrected: "", raw: "" }, endpoints: {} },
      window: { measuredMs: holdS * 1000 },
      thresholds,
      environment: { os: "test", arch: "x", cpus: 1, cpuModel: "x", node: "24", targetHost: "127.0.0.1" },
    } as unknown as PerformanceData;
    const res: EngineResult<PerformanceData> = {
      schemaVersion: 1,
      engine: "performance",
      runId: `perf-${++n}`,
      status: thresholds.some((t) => !t.passed) ? "failed" : "passed",
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(0).toISOString(),
      findings: [],
      limitations: isCapped
        ? [
            {
              code: "PERF-THROTTLED-BY-SAFETY",
              message: `${requests} requests waited for the safety rate cap (${model.capRps} req/s = min(safety.maxRps, budget.maxRps)); throughput reflects the cap, not the target's capacity.`,
              impact: "reduces-confidence",
            },
          ]
        : [],
      artifacts: [],
      data,
    };
    return res;
  };
}

/** Minimal StageResult for pure analysis tests. */
export function stage(level: number, p95: number, over: Partial<StageResult> = {}): StageResult {
  return {
    index: 0,
    kind: "step",
    label: `step ${level}`,
    level,
    holdMs: 1000,
    settleMs: 0,
    status: "passed",
    breachReasons: [],
    perfRunId: "r",
    perfStatus: "passed",
    startedAt: "",
    endedAt: "",
    startMs: 0,
    endMs: 0,
    measuredMs: 1000,
    requests: 100,
    ok: 100,
    failed: 0,
    errorRate: 0,
    throughput: level * 10,
    meanInFlight: level,
    latency: { mean: p95, p50: p95, p90: p95, p95, p99: p95, max: p95 },
    thresholds: [],
    generator: { saturated: false, reasons: [], cpuPercent: 1, eventLoopDelayP99Ms: 1 },
    invalid: false,
    capped: false,
    throttled: 0,
    abortedEarly: false,
    series: [],
    ...over,
  };
}
