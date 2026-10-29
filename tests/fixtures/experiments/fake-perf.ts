/** Minimal PerformanceData / EngineResult doubles for What-If orchestration tests (no network). */
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import type { PerformanceData } from "../../../src/engines/performance/types.js";

export interface FakeRun {
  p50?: number;
  p95: number;
  p99?: number;
  mean?: number;
  rps?: number;
  errorRate?: number;
  hostname?: string;
}

function lat(p: FakeRun) {
  const p95 = p.p95;
  return {
    count: 1000,
    min: p95 * 0.3,
    mean: p.mean ?? p95 * 0.6,
    stdDev: p95 * 0.1,
    p50: p.p50 ?? p95 * 0.5,
    p75: p95 * 0.7,
    p90: p95 * 0.9,
    p95,
    p99: p.p99 ?? p95 * 1.2,
    p999: p95 * 1.5,
    max: p95 * 2,
  };
}

export function fakePerfData(target: string, r: FakeRun): PerformanceData {
  const l = lat(r);
  return {
    schema: 1,
    target,
    model: "closed",
    config: {
      durationMs: 1000,
      rampUpMs: 0,
      warmupMs: 0,
      gracefulStopMs: 0,
      timeoutMs: 1000,
      connections: 1,
      scenarios: [],
    },
    window: { startedAt: "", endedAt: "", measuredMs: 1000, warmupMs: 0, stopReason: "completed" },
    totals: {
      requests: 100,
      ok: 100,
      failed: 0,
      timeouts: 0,
      interrupted: 0,
      dropped: 0,
      budgetRefused: 0,
      iterations: 100,
      bytesIn: 0,
      bytesOut: 0,
      rps: r.rps ?? 100,
      okRps: r.rps ?? 100,
      failedRps: 0,
      errorRate: r.errorRate ?? 0,
      timeoutRate: 0,
    },
    latency: { corrected: l, raw: l },
    endpoints: [],
    scenarios: [],
    status: {},
    errors: [],
    errorSamples: [],
    firstErrors: [],
    histograms: { unit: "us", global: { corrected: "", raw: "" }, endpoints: {} },
    series: [],
    warmup: { requests: 0, latency: { corrected: l, raw: l } },
    generator: {
      eventLoopDelayP99Ms: 0,
      eventLoopDelayMaxMs: 0,
      cpuPercent: 1,
      schedulingLagP99Ms: 0,
      schedulingLagMaxMs: 0,
      dropped: 0,
      meanInFlight: 1,
      littlesLawExpected: 1,
      littlesLawMismatch: 0,
      maxOpenSockets: 1,
      saturated: false,
      reasons: [],
      remedies: [],
    },
    thresholds: [],
    environment: {
      os: "test",
      arch: "x64",
      cpus: 8,
      cpuModel: "cpu",
      node: "24",
      hostname: r.hostname ?? "host",
      targetHost: "127.0.0.1",
    },
    methods: { latency: "", percentiles: "", throughput: "", errorRate: "", coCorrection: "" },
  };
}

export function fakeResult(target: string, r: FakeRun, id = "perf"): EngineResult<PerformanceData> {
  return {
    schemaVersion: 1,
    engine: "performance",
    runId: id,
    status: "passed",
    startedAt: "",
    endedAt: "",
    findings: [],
    limitations: [],
    artifacts: [],
    data: fakePerfData(target, r),
  };
}
