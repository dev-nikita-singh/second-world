/**
 * Branch tests for Performance Lab threshold evaluation (src/engines/performance/thresholds.ts;
 * docs/08-configuration.md §4, docs/03-engines/performance-lab.md §4). Owner: sw-coverage (Wave 5).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  evaluateThresholds,
  parseInputThresholds,
  type ScopeView,
  scopeResolver,
  statValue,
  thresholdFindings,
} from "../../../src/engines/performance/thresholds.js";
import { LatencyHistogram } from "../../../src/shared/stats/hdr.js";

function view(latMs: number[], p: Partial<ScopeView> = {}): ScopeView {
  const latency = new LatencyHistogram();
  for (const ms of latMs) latency.record(ms * 1000);
  return { latency, requests: 10, ok: 8, failed: 2, timeouts: 1, windowSec: 5, ...p };
}

describe("statValue", () => {
  it("every stat on data and on empty views", () => {
    const v = view([10, 20, 30]);
    const e = view([], { requests: 0, ok: 0, failed: 0, timeouts: 0, windowSec: 0 });
    const cases: Array<[Parameters<typeof statValue>[0], number | null, number | null]> = [
      [{ stat: "p95", percentile: 95 }, 30, null],
      [{ stat: "avg" }, 20, null],
      [{ stat: "max" }, 30, null],
      [{ stat: "min" }, 10, null],
      [{ stat: "med" }, 20, null],
      [{ stat: "rps" }, 2, null],
      [{ stat: "error_rate" }, 0.2, null],
      [{ stat: "timeout_rate" }, 0.1, null],
      [{ stat: "success_rate" }, 0.8, null],
      [{ stat: "check_rate" }, 0.8, null],
      [{ stat: "count" }, 10, 0],
      [{ stat: "requests" }, 10, 0],
      [{ stat: "errors" }, 2, 0],
      [{ stat: "timeouts" }, 1, 0],
      [{ stat: "nonsense" }, null, null],
    ];
    for (const [t, onData, onEmpty] of cases) {
      const a = statValue(t, v);
      if (onData === null) expect(a, t.stat).toBeNull();
      else expect(a as number, t.stat).toBeCloseTo(onData, 1);
      expect(statValue(t, e), `${t.stat} empty`).toBe(onEmpty);
    }
  });

  it("property: error_rate + success_rate = 1 when ok + failed = requests", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 1000 }), (req, f) => {
        const failed = f % (req + 1);
        const v = view([1], { requests: req, ok: req - failed, failed });
        expect(
          (statValue({ stat: "error_rate" }, v) as number) +
            (statValue({ stat: "success_rate" }, v) as number),
        ).toBeCloseTo(1, 12);
      }),
    );
  });
});

describe("evaluateThresholds + scopes", () => {
  const metrics = {
    global: { corrected: view([5, 50]).latency },
    requests: 10,
    ok: 9,
    failed: 1,
    timeouts: 0,
    scenarios: new Map([
      [
        "checkout",
        { latency: { corrected: view([100]).latency }, requests: 4, ok: 4, failed: 0, timeouts: 0 },
      ],
    ]),
    endpoints: new Map([
      ["GET /a", { latency: { corrected: view([7]).latency }, requests: 3, ok: 1, failed: 2, timeouts: 2 }],
    ]),
  } as never;
  const resolve = scopeResolver(metrics, 2);

  it("resolves http / scenario / endpoint scopes; unknown scopes have no data", () => {
    expect(resolve("http")?.requests).toBe(10);
    expect(resolve("scenario.checkout")?.requests).toBe(4);
    expect(resolve("scenario.nope")).toBeUndefined();
    expect(resolve("endpoint.GET /a")?.failed).toBe(2);
    expect(resolve("endpoint.nope")).toBeUndefined();
    expect(resolve("other")).toBeUndefined();
  });

  it("pass/fail, no-data reasons and findings", () => {
    const entries = parseInputThresholds({
      "http.p95": "< 100ms",
      "http.error_rate": "< 5%",
      "scenario.checkout": "p(99) < 50ms",
      "scenario.ghost": "p(99) < 50ms",
      "endpoint.GET /a": { expr: "error_rate < 10%", abortOnFail: true },
    });
    const res = evaluateThresholds(entries, resolve);
    expect(res.map((r) => r.passed)).toEqual([true, false, false, false, false]);
    expect(res[3]?.reason).toBe('no data for scope "scenario.ghost"');
    expect(res[4]?.abortOnFail).toBe(true);
    const empty = evaluateThresholds(parseInputThresholds({ "http.p95": "< 1ms" }), () =>
      view([], { requests: 0 }),
    );
    expect(empty[0]).toMatchObject({ actual: null, passed: false, reason: "no data for this statistic" });
    let id = 0;
    const findings = thresholdFindings(res, {
      newId: () => `f${id++}`,
      isoNow: () => "2026-01-01T00:00:00.000Z",
      runId: "run",
      target: "http://127.0.0.1:1",
      window: { start: "a", end: "b" },
      confidence: 0.9,
      seed: 1,
    });
    expect(findings).toHaveLength(4);
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(4);
    const noData = findings.find((f) => JSON.stringify(f.evidence).includes("no data for scope"));
    expect(noData).toBeDefined();
    const again = thresholdFindings(res, {
      newId: () => "x",
      isoNow: () => "t",
      runId: "r2",
      target: "http://127.0.0.1:1",
      confidence: 1,
      severity: "low",
    });
    expect(again.map((f) => f.fingerprint)).toEqual(findings.map((f) => f.fingerprint)); // stable across runs
    expect(again[0]?.severity).toBe("low");
  });
});
