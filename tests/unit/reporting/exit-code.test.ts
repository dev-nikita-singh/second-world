import { describe, expect, it } from "vitest";
import { ConfigError, ExitCode, SafetyError } from "../../../src/core/errors.js";
import { computeExitCode, exitCodeForError, isFailOn } from "../../../src/engines/reporting/exit-code.js";
import { combineResults, computeVerdict, type FailOn, sortFindings } from "../../../src/engines/reporting/model.js";
import { makeFinding, makePerfData, makeResult, makeThreshold } from "../../fixtures/reports.js";

const sevs = ["critical", "high", "medium", "low", "info"] as const;
const levels: FailOn[] = ["critical", "high", "medium", "low", "never"];

describe("computeExitCode (evidence-and-history §A.6)", () => {
  it("clean run → 0 at every level", () => {
    for (const l of levels) expect(computeExitCode([makeResult()], l)).toBe(ExitCode.Ok);
    expect(computeExitCode([])).toBe(0);
  });

  it("finding severity × fail-on matrix (open reproduced defects)", () => {
    // expected[sev][failOn]
    const expected: Record<(typeof sevs)[number], Record<FailOn, number>> = {
      critical: { critical: 1, high: 1, medium: 1, low: 1, never: 0 },
      high: { critical: 0, high: 1, medium: 1, low: 1, never: 0 },
      medium: { critical: 0, high: 0, medium: 1, low: 1, never: 0 },
      low: { critical: 0, high: 0, medium: 0, low: 1, never: 0 },
      info: { critical: 0, high: 0, medium: 0, low: 0, never: 0 },
    };
    for (const s of sevs) {
      for (const l of levels) {
        const r = makeResult({ engine: "bugs", findings: [makeFinding({ severity: s, classification: "reproduced-defect" })] });
        expect(computeExitCode([r], l), `${s} @ ${l}`).toBe(expected[s][l]);
      }
    }
  });

  it("hypotheses, verified fixes and closed findings never fail", () => {
    for (const f of [
      makeFinding({ severity: "critical", classification: "hypothesis" }),
      makeFinding({ severity: "critical", classification: "verified-fix" }),
      makeFinding({ severity: "critical", classification: "reproduced-defect", status: "false-positive" }),
      makeFinding({ severity: "critical", classification: "reproduced-defect", status: "wont-fix" }),
    ]) {
      expect(computeExitCode([makeResult({ findings: [f] })], "low")).toBe(0);
    }
  });

  it("threshold breaches fail regardless of severity, except with never", () => {
    const f = makeFinding({ severity: "info", classification: "threshold-breach" });
    expect(computeExitCode([makeResult({ findings: [f] })], "critical")).toBe(1);
    expect(computeExitCode([makeResult({ findings: [f] })], "never")).toBe(0);
    const d = makePerfData({ thresholds: [makeThreshold({ passed: false, actual: 400 })] });
    expect(computeExitCode([makeResult({ data: d })], "critical")).toBe(1);
  });

  it("status precedence: cancelled 130 > error 70 > failures 1", () => {
    const failing = makeResult({ findings: [makeFinding({ severity: "critical", classification: "reproduced-defect" })] });
    expect(computeExitCode([failing, makeResult({ status: "error" })])).toBe(70);
    expect(computeExitCode([failing, makeResult({ status: "error" }), makeResult({ status: "cancelled" })])).toBe(130);
    expect(computeExitCode([makeResult({ status: "cancelled" })], "never")).toBe(130);
    expect(computeExitCode([makeResult({ status: "failed" })])).toBe(1);
    expect(computeExitCode([makeResult({ status: "failed" })], "never")).toBe(0);
    expect(computeExitCode([makeResult({ status: "partial" })])).toBe(0);
  });

  it("errors thrown instead of results map to their exit code", () => {
    expect(exitCodeForError(new ConfigError("SW_CONFIG_X", "bad"))).toBe(2);
    expect(exitCodeForError(new SafetyError("SW_SAFETY_PUBLIC", "no"))).toBe(3);
    expect(exitCodeForError(new Error("boom"))).toBe(70);
  });

  it("isFailOn", () => {
    expect(isFailOn("high")).toBe(true);
    expect(isFailOn("HIGH")).toBe(false);
    expect(isFailOn(3)).toBe(false);
  });
});

describe("verdict and combineResults", () => {
  it("explains the failure reasons deterministically", () => {
    const d = makePerfData({ thresholds: [makeThreshold({ passed: false }), makeThreshold({ expression: "b" })] });
    const v = computeVerdict(
      [makeResult({ data: d }), makeResult({ engine: "bugs", findings: [makeFinding({ severity: "high", classification: "reproduced-defect" })] })],
      "high",
    );
    expect(v).toEqual({ passed: false, exitCode: 1, reasons: ["1 threshold(s) breached", "1 finding(s) at or above severity 'high'"] });
  });

  it("combines timestamps, status and meta", () => {
    const rep = combineResults(
      [
        makeResult({ startedAt: "2026-10-29T10:00:05.000Z", endedAt: "2026-10-29T10:00:06.000Z" }),
        makeResult({ engine: "bugs", status: "partial", startedAt: "2026-10-29T10:00:00.000Z", endedAt: "2026-10-29T10:00:03.000Z" }),
      ],
      { runId: "R", toolVersion: "1.2.3", configHash: "abc" },
    );
    expect(rep).toMatchObject({
      schemaVersion: 1,
      kind: "second-world-report",
      runId: "R",
      toolVersion: "1.2.3",
      configHash: "abc",
      startedAt: "2026-10-29T10:00:00.000Z",
      endedAt: "2026-10-29T10:00:06.000Z",
      durationMs: 6000,
      status: "partial",
      failOn: "high",
    });
    expect(rep.verdict.passed).toBe(true);
    expect(rep.verdict.reasons[1]).toMatch(/partial results: bugs/);
  });

  it("sortFindings: classification strongest first, then severity, then title", () => {
    const fs = [
      makeFinding({ id: "1", title: "b", severity: "low", classification: "hypothesis" }),
      makeFinding({ id: "2", title: "a", severity: "low", classification: "reproduced-defect" }),
      makeFinding({ id: "3", title: "z", severity: "critical", classification: "reproduced-defect" }),
      makeFinding({ id: "4", title: "c", severity: "high", classification: "threshold-breach" }),
      makeFinding({ id: "5", title: "a", severity: "critical", classification: "reproduced-defect" }),
    ];
    expect(sortFindings(fs).map((f) => f.id)).toEqual(["5", "3", "2", "4", "1"]);
  });
});
