/**
 * Tests for `sw analyze` inputs and the deterministic summary (src/engines/summary/*).
 * Report files are user-supplied JSON, so malformed input is in scope. Owner: sw-coverage (Wave 5).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import { deterministicSummary } from "../../../src/engines/summary/deterministic.js";
import { loadReports, resultsFromJson } from "../../../src/engines/summary/sources.js";

const SEVS = ["critical", "high", "medium", "low", "info"] as const;
const CLASSES = ["verified-fix", "reproduced-defect", "threshold-breach", "observation", "suspected-risk", "hypothesis"] as const;

const finding = fc.record({
  title: fc.string({ maxLength: 10 }),
  severity: fc.constantFrom(...SEVS),
  classification: fc.constantFrom(...CLASSES),
  engine: fc.constantFrom("performance", "bugs"),
});
const result = fc.record({
  engine: fc.constantFrom("performance", "bugs", "stress"),
  runId: fc.string({ minLength: 1, maxLength: 5 }),
  status: fc.constantFrom("passed", "failed", "error"),
  findings: fc.array(finding, { maxLength: 8 }),
  limitations: fc.array(fc.record({ impact: fc.constantFrom("invalidates", "reduces", "none"), message: fc.string({ maxLength: 8 }) }), { maxLength: 3 }),
  artifacts: fc.constant([]),
});

describe("deterministicSummary", () => {
  it("property: counts are consistent; top findings are ordered by severity then evidence strength", () => {
    fc.assert(
      fc.property(fc.array(result, { maxLength: 5 }), fc.integer({ min: 1, max: 10 }), (rs, top) => {
        const s = deterministicSummary(rs as never, { top });
        const n = rs.reduce((k, r) => k + r.findings.length, 0);
        expect(s.counts.findings).toBe(n);
        expect(Object.values(s.counts.bySeverity).reduce((a, b) => a + b, 0)).toBe(n);
        expect(Object.values(s.counts.byClassification).reduce((a, b) => a + (b ?? 0), 0)).toBe(n);
        expect(Object.values(s.counts.statuses).reduce((a, b) => a + b, 0)).toBe(rs.length);
        expect(s.topFindings.length).toBe(Math.min(top, n));
        const sevIdx = s.topFindings.map((f) => SEVS.indexOf(f.severity));
        for (let i = 1; i < sevIdx.length; i++) expect(sevIdx[i]).toBeGreaterThanOrEqual(sevIdx[i - 1] as number);
        expect(s.text.split("\n")).toHaveLength(1 + s.bullets.length);
        const invalidating = rs.flatMap((r) => r.limitations).filter((l) => l.impact === "invalidates").length;
        expect(s.bullets.filter((b) => b.startsWith("Limitation (")).length).toBe(invalidating);
      }),
    );
  });

  it("headlines for empty input, no findings and serious findings", () => {
    expect(deterministicSummary([]).headline).toBe("No results to summarise.");
    const base = { engine: "performance", runId: "r", status: "passed", findings: [], limitations: [], artifacts: [] };
    expect(deterministicSummary([base] as never).headline).toBe("1 run(s) (performance) produced no findings.");
    const f = { title: "t", severity: "high", classification: "observation", engine: "performance" };
    expect(deterministicSummary([{ ...base, findings: [f] }] as never).headline).toMatch(/1 of severity high or critical/);
  });

  // Regression (sw-coverage bug report, fixed by main): severities outside the schema (hand-edited / other-version report JSON fed to
  // `sw analyze`) are ranked ABOVE "critical" (src/engines/summary/deterministic.ts:34:
  // SEV_ORDER.indexOf(...) = -1 → (5 - -1) * 10 = 60) and counted as NaN in bySeverity.
  it("unknown severities never outrank critical findings", () => {
    const base = { engine: "bugs", runId: "r", status: "failed", limitations: [], artifacts: [] };
    const s = deterministicSummary([
      { ...base, findings: [
        { title: "real", severity: "critical", classification: "reproduced-defect", engine: "bugs" },
        { title: "odd", severity: "urgent", classification: "observation", engine: "bugs" },
      ] },
    ] as never);
    expect(s.topFindings[0]?.title).toBe("real");
  });
});

describe("report sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-summary-cov-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const r = { engine: "performance", runId: "1", status: "passed" };

  it("accepts single results, arrays and combined reports; fills missing arrays", () => {
    expect(resultsFromJson(r)[0]).toMatchObject({ findings: [], limitations: [], artifacts: [] });
    expect(resultsFromJson([r, { nope: 1 }, r])).toHaveLength(2);
    expect(resultsFromJson({ kind: "second-world-report", results: [r] })).toHaveLength(1);
    for (const bad of [null, 1, "x", [], { results: [] }, { engine: 1, runId: "x", status: "s" }]) {
      expect(() => resultsFromJson(bad, "f.json"), JSON.stringify(bad)).toThrow(/f\.json does not contain/);
    }
  });

  it("loads files relative to cwd and EngineResult objects; unreadable/invalid files are ConfigErrors", async () => {
    writeFileSync(join(dir, "a.json"), JSON.stringify([r, r]));
    writeFileSync(join(dir, "bad.json"), "{nope");
    const out = await loadReports(["a.json", { ...r, findings: [], limitations: [], artifacts: [] } as never], dir);
    expect(out).toHaveLength(3);
    await expect(loadReports(["missing.json"], dir)).rejects.toBeInstanceOf(ConfigError);
    await expect(loadReports(["bad.json"], dir)).rejects.toBeInstanceOf(ConfigError);
  });
});
