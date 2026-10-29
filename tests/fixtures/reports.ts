/** Deterministic EngineResult / Finding / PerformanceData builders for reporting tests. */
import type { EngineResult, Finding } from "../../src/core/evidence/schemas.js";
import type { BugsData } from "../../src/engines/bugs/types.js";
import type { MetricComparison } from "../../src/engines/experiments/analysis.js";
import type { EvolutionData, ExperimentData } from "../../src/engines/experiments/types.js";
import type { RunComparison } from "../../src/engines/history/types.js";
import type { ModelData, ModelEvidence } from "../../src/engines/model/types.js";
import type {
  LatencySummaryMs,
  PerformanceData,
  ThresholdResult,
} from "../../src/engines/performance/types.js";
import type { PhaseStats } from "../../src/engines/reliability/detectors.js";
import type { ReliabilityData } from "../../src/engines/reliability/types.js";
import type { StageResult, StressData } from "../../src/engines/stress/types.js";

export function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    schemaVersion: 1,
    id: "01J00000000000000000000001",
    fingerprint: "fp-1",
    engine: "performance",
    category: "performance",
    title: "Something happened",
    description: "",
    severity: "medium",
    classification: "observation",
    status: "open",
    confidence: 0.9,
    evidence: [{ kind: "note", text: "x" }],
    locations: [],
    affected: [],
    related: [],
    occurrences: 1,
    firstSeen: "2026-10-29T10:00:00.000Z",
    lastSeen: "2026-10-29T10:00:00.000Z",
    tags: [],
    ...over,
  };
}

export function makeResult<D = unknown>(over: Partial<EngineResult<D>> = {}): EngineResult<D> {
  return {
    schemaVersion: 1,
    engine: "performance",
    runId: "run-1",
    status: "passed",
    startedAt: "2026-10-29T10:00:00.000Z",
    endedAt: "2026-10-29T10:00:12.500Z",
    findings: [],
    limitations: [],
    artifacts: [],
    ...over,
  };
}

export function lat(p50: number, scale = 1): LatencySummaryMs {
  return {
    count: 1000,
    min: p50 * 0.5 * scale,
    mean: p50 * 1.1 * scale,
    stdDev: 3,
    p50: p50 * scale,
    p75: p50 * 1.2 * scale,
    p90: p50 * 1.5 * scale,
    p95: p50 * 1.8 * scale,
    p99: p50 * 2.5 * scale,
    p999: p50 * 3 * scale,
    max: p50 * 4 * scale,
  };
}

export function makeThreshold(over: Partial<ThresholdResult> = {}): ThresholdResult {
  return {
    expression: "http.p95 < 300ms",
    metric: "http.p95",
    op: "<",
    threshold: 300,
    unit: "ms",
    actual: 90,
    passed: true,
    abortOnFail: false,
    ...over,
  };
}

export function makePerfData(over: Partial<PerformanceData> = {}): PerformanceData {
  return {
    schema: 1,
    target: "http://127.0.0.1:3000",
    model: "open",
    arrival: "constant",
    config: {
      rate: 100,
      durationMs: 10_000,
      rampUpMs: 0,
      warmupMs: 2000,
      gracefulStopMs: 5000,
      timeoutMs: 5000,
      connections: 64,
      seed: 42,
      scenarios: [{ name: "default", weight: 1, steps: 1 }],
    },
    window: {
      startedAt: "2026-10-29T10:00:00.000Z",
      endedAt: "2026-10-29T10:00:12.000Z",
      measuredMs: 10_000,
      warmupMs: 2000,
      stopReason: "completed",
    },
    totals: {
      requests: 1000,
      ok: 990,
      failed: 10,
      timeouts: 0,
      interrupted: 0,
      dropped: 0,
      budgetRefused: 0,
      iterations: 1000,
      bytesIn: 100_000,
      bytesOut: 10_000,
      rps: 100,
      okRps: 99,
      failedRps: 1,
      errorRate: 0.01,
      timeoutRate: 0,
      targetRate: 100,
      achievedRate: 99.8,
    },
    latency: { corrected: lat(50), raw: lat(48) },
    endpoints: [
      {
        key: "GET /fixed/50",
        method: "GET",
        path: "/fixed/50",
        scenario: "default",
        requests: 1000,
        ok: 990,
        failed: 10,
        timeouts: 0,
        rps: 100,
        errorRate: 0.01,
        bytesIn: 100_000,
        bytesOut: 10_000,
        latency: { corrected: lat(50), raw: lat(48) },
        ttfb: lat(49),
        status: { "200": 990, "500": 10 },
        errors: {},
      },
    ],
    scenarios: [],
    status: { "200": 990, "500": 10 },
    errors: [{ kind: "http-500", count: 10 }],
    errorSamples: [],
    firstErrors: [],
    histograms: { unit: "us", global: { corrected: "", raw: "" }, endpoints: {} },
    series: [],
    warmup: { requests: 100, latency: { corrected: lat(50), raw: lat(48) } },
    generator: {
      eventLoopDelayP99Ms: 2.5,
      eventLoopDelayMaxMs: 8,
      cpuPercent: 20,
      schedulingLagP99Ms: 0.4,
      schedulingLagMaxMs: 1,
      dropped: 0,
      meanInFlight: 5,
      littlesLawExpected: 5,
      littlesLawMismatch: 0.01,
      maxOpenSockets: 8,
      saturated: false,
      reasons: [],
      remedies: [],
    } as PerformanceData["generator"],
    thresholds: [makeThreshold()],
    environment: { os: "win32", arch: "x64", cpus: 8, cpuModel: "x", node: "v24", targetHost: "127.0.0.1" },
    methods: {
      latency: "HDR histogram, µs, 3 significant digits",
      percentiles: "nearest-rank",
      throughput: "completed / measured window",
      errorRate: "failed / (ok + failed)",
      coCorrection: "expected-interval back-fill",
    },
    ...over,
  };
}

// ------------------------------------------------------------------ stress / history

export const CAPACITY_STATEMENT =
  "Tested capacity: 200 req/s met all requirements (p95 < 300ms, errors < 1%) in this environment; 400 req/s did not.";

export function makeStage(index: number, level: number, over: Partial<StageResult> = {}): StageResult {
  const p95 = 20 + index * 40;
  return {
    index,
    kind: "step" as StageResult["kind"],
    label: `step ${index}`,
    level,
    holdMs: 5000,
    settleMs: 0,
    status: "passed",
    breachReasons: [],
    perfRunId: `perf-${index}`,
    perfStatus: "passed",
    startedAt: "2026-10-29T10:00:00.000Z",
    endedAt: "2026-10-29T10:00:05.000Z",
    startMs: index * 5000,
    endMs: index * 5000 + 5000,
    measuredMs: 5000,
    requests: level * 5,
    ok: level * 5,
    failed: 0,
    errorRate: 0,
    throughput: level * 0.99,
    meanInFlight: level / 50,
    latency: { mean: p95 / 2, p50: p95 / 2, p90: p95 * 0.9, p95, p99: p95 * 1.5, max: p95 * 2 },
    thresholds: [],
    generator: { saturated: false, reasons: [], cpuPercent: 20, eventLoopDelayP99Ms: 2 },
    invalid: false,
    abortedEarly: false,
    series: [],
    ...over,
  };
}

export function makeStressData(over: Partial<StressData> = {}): StressData {
  const stages = [
    makeStage(0, 50),
    makeStage(1, 100),
    makeStage(2, 200),
    makeStage(3, 400, {
      status: "breached",
      breachReasons: ["http.p95 < 300ms"],
      errorRate: 0.02,
      failed: 40,
    }),
    makeStage(4, 800, {
      status: "breached",
      breachReasons: ["error-rate"],
      invalid: true,
      generator: { saturated: true, reasons: ["cpu"], cpuPercent: 99, eventLoopDelayP99Ms: 80 },
    }),
  ];
  return {
    schema: 1,
    mode: "step",
    loadType: "rate",
    target: "http://127.0.0.1:3000/api",
    stopReason: "breach",
    stopDetail: "first breach at stage 3",
    stages,
    invalidFromStage: 4,
    capacity: { testedCapacity: 200, stageIndex: 2, statement: CAPACITY_STATEMENT },
    firstBreach: {
      stageIndex: 3,
      level: 400,
      metric: "http.p95",
      expression: "http.p95 < 300ms",
      actual: 340,
      threshold: 300,
    },
    knee: { stageIndex: 2, level: 200, p95: 100, strength: 2.5 },
    usl: {
      kind: "estimate",
      lambda: 1.02,
      sigma: 0.05,
      kappa: 0.0001,
      r2: 0.98,
      peakN: 97.5,
      peakThroughput: 420,
      basis: "mean-in-flight",
      points: 4,
      extrapolated: true,
    },
    curves: {
      level: [50, 100, 200, 400],
      throughput: [49.5, 99, 198, 396],
      p95: [20, 60, 100, 140],
      p99: [30, 90, 150, 210],
      errorRate: [0, 0, 0, 0.02],
    },
    methods: { capacity: "highest passing stage", usl: "nonlinear least squares" },
    ...over,
  };
}

export function makeComparison(over: Partial<RunComparison> = {}): RunComparison {
  const entry = (status: "new" | "fixed" | "regressed" | "unchanged", title: string) => ({
    fingerprint: `fp-${title}`,
    status,
    title,
    engine: "bugs" as const,
    severity: "high" as const,
  });
  return {
    baselineIds: ["01BASE"],
    currentIds: ["01CUR"],
    method: "mixed",
    metrics: [
      {
        metric: "performance.http.p95",
        direction: "lower-is-better",
        method: "single-run",
        baseline: 100,
        current: 130,
        relativeChange: 0.3,
        verdict: "inconclusive",
        movement: "worse",
        note: "one run per side",
      },
      {
        metric: "performance.http.rps",
        direction: "higher-is-better",
        method: "statistical",
        baseline: 200,
        current: 180,
        relativeChange: -0.1,
        verdict: "regressed",
        ci95: [-30, -10],
        p: 0.004,
        pAdjusted: 0.008,
        n: { baseline: 5, current: 5 },
      },
    ],
    findings: {
      new: [entry("new", "BOLA on orders")],
      fixed: [entry("fixed", "N+1 on products")],
      regressed: [entry("regressed", "Stock race")],
      unchanged: [entry("unchanged", "Schema drift")],
    },
    regressions: ["performance.http.rps regressed (-10%)"],
    summary: "1 metric regressed, 1 new finding",
    ...over,
  };
}

// ------------------------------------------------------------------ bugs

export function makeBugsData(over: Partial<BugsData> = {}): BugsData {
  const summary = (o: Partial<BugsData["findings"][number]>): BugsData["findings"][number] => ({
    id: "b-1",
    fingerprint: "fp-bola",
    ruleId: "bugs/bola",
    operation: "GET /orders/{id}",
    technique: "auth",
    classification: "reproduced-defect",
    severity: "critical",
    title: "BOLA: other user can read order",
    flaky: false,
    failures: 3,
    replays: 3,
    rate: 1,
    wilson: { lower: 0.439, upper: 1 },
    occurrences: 1,
    minimized: false,
    ...o,
  });
  return {
    mode: "contract",
    target: "http://127.0.0.1:3000",
    seed: 42,
    contract: { source: "openapi.yaml", version: "1.0.0", title: "shop", hash: "h", operations: 3 },
    techniques: ["contract", "boundary", "auth", "concurrency"] as BugsData["techniques"],
    matrix: [
      {
        operation: "GET /orders/{id}",
        verdict: "fail",
        techniques: {
          contract: { cases: 4, passed: 4, failed: 0, inconclusive: 0 },
          auth: { cases: 3, passed: 1, failed: 2, inconclusive: 0 },
        },
        statuses: { "200": 6, "401": 1 },
        documentedStatuses: ["200", "401", "404"],
        findings: ["fp-bola"],
      },
      {
        operation: "POST /orders",
        verdict: "fail",
        techniques: {
          boundary: { cases: 6, passed: 4, failed: 2, inconclusive: 0 },
          concurrency: { cases: 1, passed: 0, failed: 0, inconclusive: 1 },
        },
        statuses: { "201": 4, "500": 2 },
        documentedStatuses: ["201", "400"],
        findings: ["fp-boundary", "fp-flaky"],
      },
      {
        operation: "GET /healthz",
        verdict: "untested",
        techniques: { contract: { cases: 0, passed: 0, failed: 0, inconclusive: 0 } },
        statuses: {},
        documentedStatuses: [],
        findings: [],
      },
    ] as BugsData["matrix"],
    coverage: {
      operations: { total: 3, exercised: 2 },
      statuses: { documented: 6, observed: 4 },
      techniques: { contract: 4, boundary: 6, auth: 3, concurrency: 1 },
      ratio: 0.6667,
    },
    findings: [
      summary({}),
      summary({
        id: "b-2",
        fingerprint: "fp-boundary",
        ruleId: "bugs/server-error-on-boundary",
        operation: "POST /orders",
        technique: "boundary",
        severity: "medium",
        title: "500 on qty=0",
        minimized: true,
        occurrences: 2,
      }),
      summary({
        id: "b-3",
        fingerprint: "fp-flaky",
        ruleId: "bugs/race-lost-update",
        operation: "POST /orders",
        technique: "boundary",
        severity: "high",
        title: "Oversell under concurrency",
        flaky: true,
        failures: 2,
        replays: 5,
        rate: 0.4,
        wilson: { lower: 0.118, upper: 0.769 },
      }),
    ],
    reproductions: {
      "fp-bola": {
        fingerprint: "fp-bola",
        ruleId: "bugs/bola",
        operation: "GET /orders/{id}",
        seed: 42,
        case: {} as BugsData["reproductions"][string]["case"],
        exchanges: [],
        curl: [
          `curl -sS -X POST 'http://127.0.0.1:3000/orders' -H "Authorization: $SW_AUTH_USER" -H 'content-type: application/json' --data '{"items":[{"productId":4,"qty":1}]}'`,
          `curl -sS -X GET 'http://127.0.0.1:3000/orders/ord_1' -H "Authorization: $SW_AUTH_OTHER"`,
        ],
        message: "other user got 200",
      },
      "fp-boundary": {
        fingerprint: "fp-boundary",
        ruleId: "bugs/server-error-on-boundary",
        operation: "POST /orders",
        seed: 42,
        case: {} as BugsData["reproductions"][string]["case"],
        exchanges: [],
        // a leaked literal token must never be printed
        curl: [
          `curl -sS -X POST 'http://127.0.0.1:3000/orders?token=abc123' -H 'Authorization: Bearer alice-token' -H 'Cookie: sid=s3cr3t'`,
        ],
        message: "500",
      },
    },
    requests: {
      sent: 120,
      mutationsBlocked: 0,
      rateLimited: 0,
      transportErrors: 0,
      replays: 11,
      hookRuns: 4,
    },
    mutationsAllowed: true,
    dictionary: {},
    durationMs: 3200,
    ...over,
  };
}

// ------------------------------------------------------------------ reliability

export function phase(over: Partial<PhaseStats> = {}): PhaseStats {
  return {
    requests: 20,
    errors: 0,
    timeouts: 0,
    errorRate: 0,
    timeoutRate: 0,
    p50: 12,
    p95: 25,
    p99: 30,
    avg: 14,
    max: 40,
    rps: 10,
    ...over,
  };
}

/** dependency-5xx on payments, 2 repetitions, retry storm reproduced in both, hypothesis violated. */
export function makeReliabilityData(over: Partial<ReliabilityData> = {}): ReliabilityData {
  const windows = [-3000, -2000, -1000, 0, 1000, 2000, 3000, 4000, 5000].map((tMs) => {
    const inFault = tMs >= 0 && tMs < 3000;
    return {
      tMs,
      requests: 10,
      errors: inFault ? 6 : 0,
      timeouts: 0,
      errorRate: inFault ? 0.6 : 0,
      p50: inFault ? 300 : 12,
      p95: inFault ? 900 : 25,
      proxy: inFault ? 400 : 10,
    };
  });
  const run = (index: number): ReliabilityData["runs"][number] => ({
    index,
    steadyOk: true,
    fault: { applied: true, durationMs: 3000, abortedEarly: null },
    cancelled: false,
    steady: phase(),
    during: phase({ errors: 18, errorRate: 0.6, p50: 300, p95: 900, p99: 1200 }),
    recoveryPhase: phase({ p95: 40 }),
    routes: [{ route: "orders", steady: phase(), during: phase({ errorRate: 0.6 }) }],
    windows,
    recovery: {
      recovered: true,
      recoveryMs: index === 0 ? 1000 : 2000,
      bounds: { p95Ms: 50, errorRate: 0.01 },
      consecutive: 3,
    },
    amplification: {
      faultRatio: 26,
      steadyRatio: 1,
      factor: 26,
      proxyRequests: 780,
      clientRequests: 30,
      storm: true,
    },
    jitter: null,
    breaker: {
      verdict: "no-breaker",
      baselineRatio: 1,
      earlyRatio: 26,
      lateRatio: 25,
      earlyP50: 300,
      lateP50: 310,
      lateErrorRate: 0.6,
      probeIntervalMs: null,
      reason: "dependency still called during the whole fault",
    },
    timeout: null,
    isolation: [
      {
        route: "orders",
        related: true,
        steady: phase(),
        fault: phase({ errorRate: 0.6 }),
        degraded: true,
        isolationFailure: false,
        reason: "depends on payments",
      },
      {
        route: "products",
        related: false,
        steady: phase(),
        fault: phase(),
        degraded: false,
        isolationFailure: false,
        reason: "unaffected",
      },
    ],
    checks: [
      { expression: "http.error_rate < 1%", actual: 0, passed: true, phase: "steady" },
      { expression: "http.error_rate < 5%", actual: 0.6, passed: false, phase: "fault" },
    ],
    detections: [],
  });
  return {
    schema: 1,
    scenario: "dependency-5xx",
    dependency: "payments",
    injector: "builtin",
    faults: ["http-status 503 (100%)"],
    environment: "local",
    phases: { steadyMs: 3000, faultMs: 3000, recoveryMs: 3000 },
    workload: { rate: 10, arrival: "poisson", routes: ["orders", "products"] },
    repeat: 2,
    verdict: "violated",
    reproduced: [
      { ruleId: "reliability/retry-without-backoff", hits: 2, runs: 2 },
      { ruleId: "reliability/no-circuit-breaker", hits: 1, runs: 2 },
    ],
    runs: [run(0), run(1)],
    methods: {
      recovery: "first of 3 consecutive in-bounds 1 s windows",
      amplification: "proxy arrivals / client requests",
    },
    ...over,
  };
}

// ------------------------------------------------------------------ experiments / evolution

export function makeComparisonRow(over: Partial<MetricComparison> = {}): MetricComparison {
  return {
    variant: "fixed",
    metric: "p95",
    direction: "lower-is-better",
    unit: "ms",
    verdict: "improved",
    relativeChange: -0.42,
    ci: { lower: -0.5, upper: -0.35, level: 0.95, method: "bca" },
    p: 0.0079,
    pAdjusted: 0.0317,
    hodgesLehmann: -40,
    cliffsDelta: { delta: -1, magnitude: "large" },
    medians: { baseline: 95, variant: 55.1 },
    n: { baseline: 5, variant: 5 },
    outliers: { baseline: [], variant: [] },
    relativeSd: 0.04,
    mde: 0.06,
    success: {
      criterion: "p95 improvement >= 15%",
      status: "met",
      detail: "-42.0% (CI upper -35.0%) meets >= 15%",
    },
    reasons: [],
    ...over,
  };
}

export function makeExperimentData(over: Partial<ExperimentData> = {}): ExperimentData {
  return {
    schema: 1,
    name: "search-fix",
    hypothesis: "Indexed search lowers p95 by >= 15%",
    mode: "compare",
    design: {
      repetitions: 5,
      order: "interleaved",
      seed: 7,
      lifecycle: "per-run",
      alpha: 0.05,
      bootstrap: 2000,
      equivalenceMargin: 0.02,
    },
    schedule: [],
    arms: [
      {
        name: "baseline",
        kind: "process",
        sharesProcessWith: [],
        command: "node server.js",
        fingerprint: null,
        runs: 5,
        failedRuns: 0,
        medians: { p95: 95 },
      },
      {
        name: "fixed",
        kind: "process",
        sharesProcessWith: [],
        command: "node server.js",
        fingerprint: null,
        runs: 5,
        failedRuns: 1,
        medians: { p95: 55.1 },
      },
    ],
    runs: [
      {
        index: 0,
        arm: "baseline",
        rep: 0,
        block: 0,
        status: "ok",
        durationMs: 1500,
        metrics: { p95: 95 },
        outlierMetrics: [],
      },
      {
        index: 3,
        arm: "fixed",
        rep: 1,
        block: 1,
        status: "ok",
        durationMs: 1500,
        metrics: { p95: 90 },
        outlierMetrics: ["p95"],
      },
      {
        index: 6,
        arm: "fixed",
        rep: 3,
        block: 3,
        status: "error",
        durationMs: 200,
        metrics: {},
        outlierMetrics: [],
        error: "start failed: EADDRINUSE",
      },
    ],
    metrics: [
      { name: "p95", direction: "lower-is-better", unit: "ms" },
      { name: "error_rate", direction: "lower-is-better", unit: "ratio" },
    ],
    comparisons: [
      makeComparisonRow(),
      makeComparisonRow({
        metric: "error_rate",
        unit: "ratio",
        verdict: "inconclusive",
        relativeChange: 0,
        ci: { lower: -0.1, upper: 0.12, level: 0.95, method: "bca" },
        pAdjusted: 1,
        cliffsDelta: { delta: 0.04, magnitude: "negligible" },
        medians: { baseline: 0, variant: 0 },
        recommendedRepetitions: 12,
        success: {
          criterion: "error_rate not worse",
          status: "inconclusive",
          detail: "CI includes a 12% worsening",
        },
      }),
    ],
    verdicts: [
      {
        variant: "fixed",
        hypothesis: "inconclusive",
        improved: ["p95"],
        regressed: [],
        inconclusive: ["error_rate"],
      },
    ],
    fingerprints: { consistent: false, warnings: ["arm fixed ran on a different Node version"] },
    projections: [
      {
        kind: "estimate",
        method: "mm1",
        arm: "fixed",
        rate: 200,
        basis: { rate: 100, meanMs: 30, serviceMs: 20, utilisation: 0.5 },
        utilisation: 0.95,
        saturated: false,
        meanMs: 400,
        p95Ms: 1200,
        assumptions: "Poisson arrivals, single server",
      },
      {
        kind: "estimate",
        method: "usl",
        concurrency: 64,
        throughput: 900,
        fit: { lambda: 10, sigma: 0.02, kappa: 0.0005, r2: 0.97, peakN: 44 },
        extrapolated: true,
      },
    ],
    warnings: [],
    methods: { verdict: "Holm-adjusted Mann-Whitney + BCa bootstrap CI" },
    ...over,
  };
}

export function makeAAData(): ExperimentData {
  return makeExperimentData({
    name: "aa",
    mode: "aa",
    hypothesis: undefined,
    comparisons: [
      makeComparisonRow({
        variant: "baseline (A/A)",
        verdict: "no-significant-change",
        relativeChange: 0.004,
        ci: { lower: -0.01, upper: 0.012, level: 0.95, method: "bca" },
        pAdjusted: 0.9,
        success: undefined,
      }),
    ],
    verdicts: [],
    noiseFloor: [{ metric: "p95", mde: 0.031, relativeSd: 0.012, recommendedFor5pct: 4 }],
    fingerprints: { consistent: true, warnings: [] },
    projections: [],
    runs: [],
  });
}

export function makeEvolutionData(over: Partial<EvolutionData> = {}): EvolutionData {
  const gates = (fail?: string): EvolutionData["candidates"][number]["gates"] => [
    { gate: "worktree", name: "worktree", ok: true, durationMs: 120 },
    { gate: "install", name: "install", ok: true, durationMs: 50, detail: "linked node_modules" },
    {
      gate: "test",
      name: "npm test",
      ok: fail !== "test",
      durationMs: 4200,
      ...(fail === "test" ? { detail: "2 tests failed" } : {}),
    },
    { gate: "replay", name: "replay", ok: true, durationMs: 0, skipped: true, detail: "no artifacts" },
    ...(fail === "test"
      ? []
      : [{ gate: "benchmark" as const, name: "benchmark", ok: true, durationMs: 15000 }]),
  ];
  return {
    schema: 1,
    repo: "/work/shop",
    baseline: { ref: "HEAD", commit: "0123456789abcdef0123" },
    finding: "perf/slow-query-full-scan",
    sandbox: { kind: "docker", image: "node:24-slim", cpus: 1, memory: "1g", network: "none" },
    install: { strategy: "link", reused: 2, installed: 0 },
    candidates: [
      {
        ref: "branch:fix/index",
        name: "fix/index",
        kind: "branch",
        commit: "aaaaaaaaaaaa",
        diff: { files: 2, insertions: 30, deletions: 12, lines: 42, stat: "2 files, +30/-12" },
        gates: gates(),
        status: "accepted",
        rejectionReasons: [],
        improvement: { p95: 0.42, rps: 0.1 },
        medians: { p95: 55 },
        verdicts: { p95: "improved", rps: "no-significant-change" },
        score: 0.31,
        pareto: true,
        rank: 1,
        dominatedBy: [],
      },
      {
        ref: "patch:cache.diff",
        name: "cache.diff",
        kind: "patch",
        diff: { files: 1, insertions: 5, deletions: 0, lines: 5, stat: "1 file, +5" },
        gates: gates("test"),
        status: "rejected",
        rejectionReasons: ["test gate failed: 2 tests failed"],
        improvement: {},
        medians: {},
        verdicts: {},
        pareto: false,
        dominatedBy: [],
      },
    ],
    rankBy: [
      { metric: "p95", direction: "lower-is-better", weight: 1 },
      { metric: "rps", direction: "higher-is-better", weight: 0.5 },
    ],
    paretoFront: ["fix/index"],
    rejected: [{ name: "cache.diff", reasons: ["test gate failed: 2 tests failed"] }],
    experiment: makeExperimentData({ name: "evolution-benchmark", hypothesis: undefined }),
    workingTree: { before: "c1", after: "c1", unchanged: true },
    worktreesCleaned: true,
    warnings: [],
    methods: { ranking: "Pareto front, then weighted score" },
    ...over,
  };
}

// ------------------------------------------------------------------ system model

const ev = (
  source: ModelEvidence["source"],
  detail: string,
  extra: Partial<ModelEvidence> = {},
): ModelEvidence => ({
  source,
  confidence: 0.9,
  origin: source === "trace" ? "otlp" : "src/payments-client.ts",
  detail,
  ...extra,
});

export const MODEL_BANNER =
  "Built from: static analysis ✓, OpenAPI ✓, config ✓, runtime traces ✓, metrics ✗. Production topology unknown.";

export function makeModelData(over: Partial<ModelData> = {}): ModelData {
  const window = { start: "2026-10-29T10:00:00.000Z", end: "2026-10-29T10:01:00.000Z" };
  return {
    schemaVersion: 1,
    builtAt: "2026-10-29T10:02:00.000Z",
    primaryService: "service:shop-express",
    nodes: [
      {
        id: "service:shop-express",
        kind: "service",
        names: ["shop-express"],
        evidence: [ev("static", "package.json"), ev("trace", "service.name=shop-express", { count: 40 })],
        confidence: 0.98,
        observed: { rps: 12.5, p95Ms: 180, errorRate: 0.02, requests: 750, window, source: "trace" },
        failureModes: [
          {
            id: "fm1",
            title: "Retry storm against payments",
            source: "reliability",
            severity: "high",
            classification: "reproduced-defect",
          },
        ],
      },
      {
        id: "route:shop-express:POST /orders",
        kind: "route",
        names: ["POST /orders"],
        evidence: [ev("openapi", "openapi.yaml#/paths/~1orders/post"), ev("static", "orders router")],
        confidence: 0.95,
        service: "service:shop-express",
        method: "POST",
        path: "/orders",
      },
      {
        id: "service:payments-fake",
        kind: "service",
        names: ["payments-fake", "PAYMENTS_URL", "payments"],
        evidence: [
          ev("static-heuristic", "fetch POST in charge()"),
          ev("config", "PAYMENTS_URL"),
          ev("trace", "peer.service=payments"),
        ],
        confidence: 0.97,
        hosts: ["127.0.0.1:4010", "payments:4010"],
        proposedMerge: true,
      },
      {
        id: "datastore:redis",
        kind: "cache",
        names: ["redis"],
        evidence: [ev("static-heuristic", "redis client import", { confidence: 0.5 })],
        confidence: 0.5,
      },
    ],
    edges: [
      {
        id: "service:shop-express->service:payments-fake:calls",
        from: "service:shop-express",
        to: "service:payments-fake",
        kind: "calls",
        evidence: [ev("static-heuristic", "fetch"), ev("trace", "client span")],
        confidence: 0.96,
        observed: { callsPerRequest: 26, p95Ms: 140, calls: 780 },
      },
      {
        id: "service:shop-express->datastore:redis:reads",
        from: "service:shop-express",
        to: "datastore:redis",
        kind: "reads",
        evidence: [ev("static-heuristic", "redis.get()", { confidence: 0.5 })],
        confidence: 0.5,
      },
    ],
    merges: [
      {
        node: "service:payments-fake",
        rule: "host-port",
        a: "env:PAYMENTS_URL",
        b: "compose:payments",
        detail: "127.0.0.1:4010",
        confidence: 1,
        proposed: false,
      },
      {
        node: "service:payments-fake",
        rule: "name-similarity",
        a: "trace:payments",
        b: "compose:payments-fake",
        detail: "jw=0.95 payments~payments-fake",
        confidence: 0.95,
        proposed: true,
      },
    ],
    coverage: {
      sources: {
        static: true,
        openapi: true,
        config: true,
        traces: true,
        metrics: false,
        performance: false,
        experiments: false,
      },
      banner: MODEL_BANNER,
      bannerAscii:
        "Built from: static analysis [x], OpenAPI [x], config [x], runtime traces [x], metrics [ ]. Production topology unknown.",
      runtimeObserved: true,
    },
    traces: {
      traces: 20,
      spans: 140,
      services: ["shop-express", "payments-fake"],
      orphanSpans: 2,
      droppedSpans: 0,
      window,
      criticalPaths: [
        {
          traceId: "t-1",
          rootSpanId: "s0",
          root: "POST /orders",
          route: "route:shop-express:POST /orders",
          durationMs: 210,
          segments: [
            {
              spanId: "s0",
              name: "POST /orders",
              service: "shop-express",
              node: "service:shop-express",
              ms: 38,
            },
            {
              spanId: "s1",
              name: "POST /charges",
              service: "payments-fake",
              node: "service:payments-fake",
              ms: 172,
            },
          ],
          byNode: [
            { node: "service:payments-fake", ms: 172, share: 0.82 },
            { node: "service:shop-express", ms: 38, share: 0.18 },
          ],
        },
      ],
      dominant: [
        {
          route: "route:shop-express:POST /orders",
          node: "service:payments-fake",
          ms: 172,
          share: 0.82,
          traces: 20,
        },
      ],
    },
    stats: { observations: 30, nodes: 4, edges: 2, merges: 2, proposedMerges: 1 },
    limitations: [
      {
        code: "MODEL_OTLP_PROTOBUF",
        message: "OTLP protobuf is not supported; send JSON",
        impact: "informational",
      },
      {
        code: "MODEL_SECRETS_NOT_STORED",
        message: "Secret values from config are never stored",
        impact: "informational",
      },
    ],
    ...over,
  };
}
