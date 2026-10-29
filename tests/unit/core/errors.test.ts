import { describe, expect, it } from "vitest";
import { ConfigError, ExitCode, isSecondWorldError, SafetyError } from "../../../src/core/errors.js";
import { FindingSchema } from "../../../src/core/evidence/schemas.js";

describe("errors", () => {
  it("maps error classes to exit codes", () => {
    const e = new ConfigError("SW_CONFIG_INVALID", "bad", { hint: "fix it" });
    expect(e.exitCode).toBe(ExitCode.ConfigInvalid);
    expect(e.hint).toBe("fix it");
    expect(isSecondWorldError(e)).toBe(true);
    expect(new SafetyError("SW_SAFETY_HOST", "no").exitCode).toBe(3);
  });
});

describe("FindingSchema", () => {
  it("applies defaults and requires evidence", () => {
    const f = FindingSchema.parse({
      id: "01J", fingerprint: "fp", engine: "performance", category: "performance", title: "slow",
      severity: "high", classification: "threshold-breach", confidence: 1,
      evidence: [{ kind: "threshold", expression: "p95<300ms", actual: 420, passed: false }],
      firstSeen: "2026-10-29T00:00:00Z", lastSeen: "2026-10-29T00:00:00Z",
    });
    expect(f.status).toBe("open");
    expect(f.occurrences).toBe(1);
    expect(() => FindingSchema.parse({ ...f, evidence: [] })).toThrow();
  });
});
