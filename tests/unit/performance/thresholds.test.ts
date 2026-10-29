import { describe, expect, it } from "vitest";
import { FindingSchema } from "../../../src/core/evidence/schemas.js";
import { PerfMetrics, type RequestSample } from "../../../src/engines/performance/metrics.js";
import {
  evaluateThresholds,
  parseInputThresholds,
  scopeResolver,
  thresholdFindings,
} from "../../../src/engines/performance/thresholds.js";

function rec(m: PerfMetrics, ms: number, ok = true, kind?: string, endpoint = "GET /a"): void {
  const s: RequestSample = {
    endpoint,
    scenario: "browse",
    method: "GET",
    path: endpoint.slice(4),
    startMs: 0,
    intendedMs: 0,
    headersMs: ms,
    endMs: ms,
    status: ok ? 200 : kind === "timeout" ? 0 : 500,
    ok,
    errorKind: ok ? undefined : (kind ?? "status"),
    bytesIn: 0,
    bytesOut: 0,
  };
  m.record(s);
}

function metrics(): PerfMetrics {
  const m = new PerfMetrics({ startMs: 0, warmupEndMs: 0, random: () => 0.5 });
  for (let i = 1; i <= 100; i++) rec(m, i * 10); // 10..1000 ms
  return m;
}

describe("threshold evaluation", () => {
  it("evaluates percentile, avg, rps and error rate", () => {
    const m = metrics();
    rec(m, 5, false);
    rec(m, 5, false, "timeout");
    const entries = parseInputThresholds({
      "http.p95": "< 2s",
      "http.p(50)": "<= 300ms",
      "http.avg": "< 600ms",
      "http.rps": "> 20",
      "http.error_rate": "< 1%",
      "http.timeout_rate": "<= 1%",
      "endpoint.GET /a.p99": "< 1.1s",
    });
    const res = evaluateThresholds(entries, scopeResolver(m, 2));
    const by = Object.fromEntries(res.map((r) => [r.expression, r]));
    expect(by["http.p95: < 2s"]?.passed).toBe(true);
    expect(by["http.p(50): <= 300ms"]?.passed).toBe(false);
    expect(by["http.p(50): <= 300ms"]?.actual).toBeCloseTo(490, -1); // 102 samples incl. two 5 ms failures
    expect(by["http.avg: < 600ms"]?.passed).toBe(true);
    expect(by["http.rps: > 20"]?.actual).toBeCloseTo(51, 6);
    expect(by["http.error_rate: < 1%"]?.passed).toBe(false);
    expect(by["http.error_rate: < 1%"]?.actual).toBeCloseTo(2 / 102, 6);
    expect(by["http.timeout_rate: <= 1%"]?.passed).toBe(true);
    expect(by["endpoint.GET /a.p99: < 1.1s"]?.passed).toBe(true);
  });

  it("a metric without data fails with a reason", () => {
    const m = metrics();
    const res = evaluateThresholds(
      parseInputThresholds({ "scenario.checkout.p99": "< 1s" }),
      scopeResolver(m, 1),
    );
    expect(res[0]?.passed).toBe(false);
    expect(res[0]?.actual).toBeNull();
    expect(res[0]?.reason).toMatch(/scenario\.checkout/);
  });

  it("produces schema-valid threshold-breach findings with threshold + measurement evidence", () => {
    const m = metrics();
    const res = evaluateThresholds(
      parseInputThresholds({ "http.p95": "< 100ms", "http.max": { expr: "< 5s", abortOnFail: true } }),
      scopeResolver(m, 1),
    );
    let n = 0;
    const findings = thresholdFindings(res, {
      newId: () => `id${n++}`,
      isoNow: () => "2026-01-01T00:00:00.000Z",
      runId: "run1",
      target: "http://127.0.0.1:3000",
      confidence: 0.9,
      seed: 7,
    });
    expect(findings).toHaveLength(1);
    const f = FindingSchema.parse(findings[0]);
    expect(f.classification).toBe("threshold-breach");
    expect(f.severity).toBe("high");
    expect(f.engine).toBe("performance");
    expect(f.evidence.map((e) => e.kind)).toEqual(["threshold", "measurement"]);
    expect(f.evidence[1]).toMatchObject({ kind: "measurement", metric: "http.p95", unit: "ms" });
    expect(f.reproduction?.seed).toBe(7);
    expect(res[1]?.abortOnFail).toBe(true);
  });
});
