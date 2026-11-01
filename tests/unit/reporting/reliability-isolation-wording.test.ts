import { describe, expect, it } from "vitest";
import type { ReliabilityData } from "../../../src/engines/reliability/types.js";
import { detectorSummaries } from "../../../src/engines/reporting/reliability.js";
import { makeReliabilityData } from "../../fixtures/reports.js";

// Regression (wave 7): a degraded route without `dependsOn` printed
// "degraded (expected, depends on it) (relation unknown)" — "expected" and "unknown" contradict.
type Iso = ReliabilityData["runs"][number]["isolation"][number];

function isolationDetail(
  rows: Array<Pick<Iso, "route" | "related" | "degraded" | "isolationFailure">>,
): string {
  const base = makeReliabilityData();
  const tmpl = base.runs[0]?.isolation[0] as Iso;
  const runs = base.runs.map((r) => ({ ...r, isolation: rows.map((x) => ({ ...tmpl, ...x })) }));
  const s = detectorSummaries({ ...base, runs }).find((x) => x.name === "isolation");
  return s?.detail ?? "";
}

describe("isolation wording is consistent with what is known", () => {
  it("degraded + relation unknown is not called 'expected'", () => {
    const t = isolationDetail([{ route: "orders", related: null, degraded: true, isolationFailure: false }]);
    expect(t).not.toContain("expected");
    expect(t).toContain("orders: degraded (relation unknown: declare dependsOn");
  });
  it("degraded + depends on the dependency is expected and names it", () => {
    const t = isolationDetail([{ route: "orders", related: true, degraded: true, isolationFailure: false }]);
    expect(t.startsWith("orders: degraded (expected: depends on payments) [")).toBe(true);
  });
  it("ok routes and failures", () => {
    const t = isolationDetail([
      { route: "a", related: null, degraded: false, isolationFailure: false },
      { route: "b", related: false, degraded: true, isolationFailure: true },
    ]);
    expect(t.startsWith("a: ok; b: ISOLATION FAILURE (does not depend on payments) [")).toBe(true);
  });
});
