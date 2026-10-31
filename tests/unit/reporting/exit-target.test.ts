/**
 * Regressions reported by sw-qa (wave 5): a down target gave `sw bugs` / `sw agent` "PASS (exit 0)"
 * and `sw perf` / `sw stress` "exit 70 (bug in SECOND WORLD)". A target that answers nothing is
 * exit 5 (docs/09 exit table).
 */
import { describe, expect, it } from "vitest";
import { ExitCode } from "../../../src/core/errors.js";
import { runBugHunt as runBugs } from "../../../src/engines/bugs/index.js";
import { computeVerdict } from "../../../src/engines/reporting/model.js";
import { makeResult } from "../../fixtures/reports.js";

const unreachable = {
  code: "target-unreachable",
  message: "Every request failed to connect",
  impact: "invalidates" as const,
};

describe("exit code for target-side errors", () => {
  it("error + target-unreachable / no-measurements → 5; other errors stay 70", () => {
    expect(computeVerdict([makeResult({ status: "error", limitations: [unreachable] })]).exitCode).toBe(
      ExitCode.TargetUnreachable,
    );
    expect(
      computeVerdict([
        makeResult({ status: "error", limitations: [{ ...unreachable, code: "no-measurements" }] }),
      ]).exitCode,
    ).toBe(ExitCode.TargetUnreachable);
    expect(computeVerdict([makeResult({ status: "error", limitations: [] })]).exitCode).toBe(
      ExitCode.Internal,
    );
    // A reduces-confidence mention is not enough.
    expect(
      computeVerdict([
        makeResult({ status: "error", limitations: [{ ...unreachable, impact: "reduces-confidence" }] }),
      ]).exitCode,
    ).toBe(ExitCode.Internal);
  });

  it("a run stopped by the Safety Guard (dns-rebind) → 3, not 70", () => {
    const r = makeResult({
      status: "error",
      limitations: [{ code: "dns-rebind", message: "rebind", impact: "invalidates" }],
    });
    expect(computeVerdict([r]).exitCode).toBe(ExitCode.SafetyBlocked);
  });

  it("bugs against a closed port: status error + target-unreachable, nothing counted as exercised", async () => {
    const res = await runBugs({
      target: "http://127.0.0.1:1",
      openapi: {
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        paths: { "/items": { get: { responses: { "200": { description: "ok" } } } } },
      },
      techniques: ["contract", "boundary"],
      timeout: 1000,
    } as never);
    expect(res.status).toBe("error");
    expect(res.limitations.map((l) => l.code)).toContain("target-unreachable");
    expect(res.data?.coverage.operations.exercised).toBe(0);
    expect(res.data?.matrix.every((r) => r.verdict === "untested")).toBe(true);
    expect(computeVerdict([res]).exitCode).toBe(ExitCode.TargetUnreachable);
  });
});
