import { describe, expect, it } from "vitest";
import { renderReport } from "../../../src/engines/reporting/index.js";
import { checkSummaries, detectorSummaries, invariantRows, isReliabilityData } from "../../../src/engines/reporting/reliability.js";
import { logicalLocation } from "../../../src/engines/reporting/sarif.js";
import { makeBugsData, makeFinding, makeReliabilityData, makeResult, makeStressData } from "../../fixtures/reports.js";

const relFindings = () => [
  makeFinding({
    id: "r1",
    fingerprint: "fp-storm",
    engine: "reliability",
    category: "reliability",
    ruleId: "reliability/retry-without-backoff",
    severity: "high",
    classification: "reproduced-defect",
    title: "Retry storm: 26x dependency calls per request",
    recommendation: "cap attempts, exponential backoff with jitter",
    affected: ["dependency:payments", "POST /orders"],
  }),
  makeFinding({
    id: "r2",
    fingerprint: "fp-cb",
    engine: "reliability",
    category: "reliability",
    ruleId: "reliability/no-circuit-breaker",
    severity: "medium",
    classification: "observation",
    title: "No circuit breaker",
    affected: ["dependency:payments"],
  }),
  makeFinding({
    id: "r3",
    fingerprint: "fp-hyp",
    engine: "reliability",
    category: "reliability",
    ruleId: "reliability/hypothesis-violated",
    severity: "high",
    classification: "threshold-breach",
    title: "Hypothesis violated: http.error_rate < 5%",
    affected: ["dependency:payments"],
  }),
];
const relResult = (data = makeReliabilityData(), extra: Partial<Parameters<typeof makeResult>[0]> = {}) =>
  makeResult({ engine: "reliability", status: "failed", data, findings: relFindings(), ...extra });

describe("reliability helpers", () => {
  it("guard distinguishes reliability data", () => {
    expect(isReliabilityData(makeReliabilityData())).toBe(true);
    expect(isReliabilityData(makeStressData())).toBe(false);
    expect(isReliabilityData(makeBugsData())).toBe(false);
  });

  it("checkSummaries aggregates across runs; detectorSummaries cover every detector", () => {
    const cs = checkSummaries(makeReliabilityData());
    expect(cs.map((c) => [c.phase, c.expression, c.passed, c.actuals.length])).toEqual([
      ["steady", "http.error_rate < 1%", true, 2],
      ["fault", "http.error_rate < 5%", false, 2],
    ]);
    const ds = detectorSummaries(makeReliabilityData());
    expect(ds.map((d) => [d.name, d.assessed, d.flagged])).toEqual([
      ["retry amplification", true, true],
      ["synchronised retries", false, false],
      ["circuit breaker", true, true],
      ["timeout correctness", false, false],
      ["isolation", true, false],
      ["recovery", true, false],
    ]);
  });

  it("logicalLocation strips the dependency: prefix for the name", () => {
    expect(logicalLocation("dependency:payments")).toEqual({ name: "payments", fullyQualifiedName: "dependency:payments", kind: "resource" });
    expect(logicalLocation("POST /orders")).toEqual({ name: "POST /orders", fullyQualifiedName: "POST /orders", kind: "resource" });
  });
});

describe("reliability rendering — tty", () => {
  const s = renderReport(
    [relResult(makeReliabilityData(), { limitations: [{ code: "injector-unavailable", message: "docker: daemon not running", impact: "invalidates" }] })],
    "tty",
    { color: false },
  );

  it("scenario and injected fault", () => {
    expect(s).toMatch(/scenario\s+dependency-5xx/);
    expect(s).toMatch(/fault\s+http-status 503 \(100%\)/);
    expect(s).toMatch(/dependency\s+payments/);
    expect(s).toMatch(/injector\s+builtin/);
    expect(s).toMatch(/verdict\s+hypothesis VIOLATED/);
    expect(s).toContain("10 req/s poisson over orders, products");
  });

  it("timeline table per phase and run, sparklines with the fault window marked", () => {
    expect(s).toContain("Experiment timeline");
    for (const p of ["steady (run 1)", "fault (run 1)", "recovery (run 2)"]) expect(s).toContain(p);
    expect(s).toContain("60.00%");
    expect(s).toMatch(/error rate per second \(run 1 of 2\) [▁▂▃▄▅▆▇█]{9}/);
    expect(s).toMatch(/p95 per second \(run 1 of 2\) ▁▁▁███▁▁▁/);
    // marker row: ^ exactly under windows 4..6 (tMs 0, 1000, 2000) of the sparkline above
    const lines = s.split("\n");
    const i = lines.findIndex((l) => l.startsWith("error rate per second"));
    const sparkStart = lines[i]!.indexOf("▁");
    expect(lines[i + 1]!.indexOf("^")).toBe(sparkStart + 3);
    expect(lines[i + 1]).toMatch(/\^\^\^ {4}fault window \(3\.0s\)$/);
  });

  it("steady-state and hypothesis verdicts with thresholds", () => {
    expect(s).toContain("Steady state & hypothesis");
    expect(s).toMatch(/steady state\s+│ http\.error_rate < 1%\s+│\s+0 \/ 0 │ held/);
    expect(s).toMatch(/hypothesis \(during fault\) │ http\.error_rate < 5%\s+│\s+0\.600 \/ 0\.600 │ VIOLATED/);
  });

  it("recovery time per run and detectors", () => {
    expect(s).toMatch(/recovery time \(run 1\)\s+1\.0s/);
    expect(s).toMatch(/recovery time \(run 2\)\s+2\.0s/);
    expect(s).toContain("Detectors");
    expect(s).toMatch(/retry amplification\s+│ FLAGGED │ 26\.00x dependency calls per request/);
    expect(s).toContain("retry storm");
    expect(s).toMatch(/synchronised retries\s+│ n\/a/);
    expect(s).toMatch(/circuit breaker\s+│ FLAGGED │ no-breaker/);
    expect(s).toMatch(/isolation\s+│ ok\s+│ orders: degraded \(expected, depends on it\); products: ok/);
  });

  it("rule hits k/n: reproduced-defect vs observation; limitations shown", () => {
    expect(s).toContain("Rule hits across repetitions");
    expect(s).toMatch(/reliability\/retry-without-backoff\s+│\s+2\/2 │ reproduced-defect/);
    expect(s).toMatch(/reliability\/no-circuit-breaker\s+│\s+1\/2 │ observation/);
    expect(s).toContain("Limitations");
    expect(s).toContain("docker: daemon not running [injector-unavailable] invalidates");
  });

  it("single repetition note, cancelled/not-applied runs, no-windows case", () => {
    const one = makeReliabilityData({ repeat: 1, runs: [makeReliabilityData().runs[0]!], reproduced: [{ ruleId: "reliability/retry-without-backoff", hits: 1, runs: 1 }] });
    const t = renderReport([relResult(one)], "tty", { color: false });
    expect(t).toContain("Single repetition: detector hits are observations");
    expect(t).not.toContain("(run 1)");
    const notApplied = makeReliabilityData({
      verdict: "inconclusive",
      runs: [{ ...makeReliabilityData().runs[0]!, fault: { applied: false, durationMs: 0, abortedEarly: null }, steadyOk: false, windows: [] }],
    });
    const u = renderReport([relResult(notApplied)], "tty", { color: false });
    expect(u).toContain("inconclusive (steady state not met or run cancelled)");
    expect(u).toContain("Run 1: fault was not applied.");
    expect(u).toContain("Run 1: steady state was not met before injection.");
    expect(u).not.toContain("per second");
  });

  it("ascii mode stays ASCII (marker row, ≈ and ≤ folded)", () => {
    const a = renderReport([relResult()], "tty", { color: false, ascii: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ascii check
    expect(a).toMatch(/^[\u0000-\u007f]*$/);
    expect(a).toContain("p95 <= 50.0ms");
  });
});

describe("reliability rendering — duplicate-operation invariants", () => {
  const ops = { ops: 30, confirmed: 20, rejected: 1, ambiguous: 9, unsent: 0, aborted: 0, retried: 9, attempts: 48, retriedDuringFault: 8 };
  const base = makeReliabilityData();
  const run0 = {
    ...base.runs[0]!,
    operations: { orders: ops },
    invariants: [
      {
        name: "orders-by-key",
        type: "no-duplicates" as const,
        status: "violated" as const,
        detail: "2 key(s) have more than one resource (3 extra of 32)",
        duplicateKeys: 2,
        extraResources: 3,
        checked: 32,
        duplicates: [
          { key: "sw-abc-r0-7", count: 3, ids: ["o1", "o2", "o3"], route: "orders", attempts: 3, statuses: [0, 0, 201], phase: "fault" as const, outcome: "ok" as const },
        ],
      },
      { name: "stock", type: "conserved" as const, status: "held" as const, detail: "sum 100 → 80 (Δ -20), allowed Δ -29..-20" },
      { name: "count", type: "count-matches" as const, status: "error" as const, detail: "not evaluated: GET /orders: HTTP 500", error: "GET /orders: HTTP 500" },
    ],
  };
  const data = makeReliabilityData({ repeat: 1, runs: [run0], reproduced: [{ ruleId: "reliability/duplicate-operation", hits: 1, runs: 1 }] });

  it("invariantRows: one row per invariant with verdict and duplicated keys", () => {
    const rows = invariantRows(data);
    expect(rows.map((r) => [r[0], r[1], (r[2] as { text: string }).text])).toEqual([
      ["orders-by-key", "no-duplicates", "VIOLATED"],
      ["stock", "conserved", "held"],
      ["count", "count-matches", "error"],
    ]);
    expect(rows[0]![3]).toBe("2 key(s) have more than one resource (3 extra of 32); e.g. sw-abc-r0-7×3 (fault)");
    expect(invariantRows(makeReliabilityData())).toEqual([]);
  });

  it("tty / md render the invariants and logical operations tables", () => {
    const t = renderReport([relResult(data)], "tty", { color: false });
    expect(t).toContain("Invariants (after recovery)");
    expect(t).toMatch(/orders-by-key\s+│ no-duplicates\s+│ VIOLATED │ 2 key\(s\)/);
    expect(t).toContain("Logical operations (one key per operation, reused on retries)");
    expect(t).toMatch(/orders\s+│\s+30 │\s+20 │\s+9 │\s+1 │ 9 \(8 during fault\)/);
    const md = renderReport([relResult(data)], "md");
    expect(md).toContain("| stock | conserved | held |");
    const none = renderReport([relResult()], "tty", { color: false });
    expect(none).not.toContain("Invariants (after recovery)");
  });
});

describe("reliability rendering — md / html / json", () => {
  it("markdown", () => {
    const md = renderReport([relResult()], "md");
    expect(md).toContain("#### Experiment timeline");
    expect(md).toContain("| fault (run 1) | 3.0s | 20 | 60.00% | 0 | 300ms | 900ms | 10 |");
    expect(md).toMatch(/error rate per second \(run 1 of 2\): \S+ \(0\.\.60 %\) — fault window \(3\.0s\): windows 4–6 of 9/);
    expect(md).toContain("| hypothesis (during fault) | http.error\\_rate &lt; 5% | 0.600 / 0.600 | VIOLATED |");
    expect(md).toContain("| reliability/retry-without-backoff | 2/2 | reproduced-defect |");
    expect(md).toContain("- **amplification**: proxy arrivals / client requests");
  });

  it("html: shaded fault window in the SVG sparkline, verdict tables, still self-contained", () => {
    const html = renderReport([relResult()], "html");
    expect(html.match(/<rect class="mark"/g)?.length).toBe(2);
    expect(html).toContain("<title>fault window (3.0s)</title></rect>");
    expect(html).toContain("shaded: fault window (3.0s)");
    expect(html).toContain('<td class="bad">VIOLATED</td>');
    expect(html).toContain("<h4>Detectors</h4>");
    expect(html).not.toMatch(/<script|\s(src|href)\s*=/i);
  });

  it("json keeps ReliabilityData intact", () => {
    const j = JSON.parse(renderReport([relResult()], "json"));
    expect(j.results[0].data.runs).toHaveLength(2);
    expect(j.results[0].data.reproduced[0]).toEqual({ ruleId: "reliability/retry-without-backoff", hits: 2, runs: 2 });
  });
});

describe("reliability rendering — junit / sarif", () => {
  it("junit: one testcase per condition and per detector", () => {
    const xml = renderReport([relResult()], "junit", { failOn: "high" });
    const names = [...xml.matchAll(/<testcase name="([^"]+)" classname="([^"]+)"/g)].map((m) => `${m[2]}::${m[1]}`);
    expect(names).toEqual([
      "reliability.steady-state::steady state: http.error_rate &lt; 1%",
      "reliability.hypothesis::hypothesis (during fault): http.error_rate &lt; 5%",
      "reliability.detectors::retry amplification",
      "reliability.detectors::synchronised retries",
      "reliability.detectors::circuit breaker",
      "reliability.detectors::timeout correctness",
      "reliability.detectors::isolation",
      "reliability.detectors::recovery",
    ]);
    expect(xml).toContain('tests="8" failures="2" errors="0" skipped="2"');
    expect(xml).toContain('<failure message="http.error_rate &lt; 5% violated during the fault" type="hypothesis-violated">');
    expect(xml).toContain('<failure message="[high] reliability/retry-without-backoff" type="reproduced-defect">');
    // circuit breaker flagged but only medium → passes at fail-on high, explained in system-out
    expect(xml).toContain("(flagged, but below fail-on &apos;high&apos;)");
    const med = renderReport([relResult()], "junit", { failOn: "medium" });
    expect(med).toContain('failures="3"');
  });

  it("sarif: dependency and route as logical locations", () => {
    const sarif = JSON.parse(renderReport([relResult()], "sarif"));
    const storm = (sarif.runs[0].results as any[]).find((r) => r.ruleId === "reliability/retry-without-backoff");
    expect(storm.locations[0].logicalLocations).toEqual([
      { name: "payments", fullyQualifiedName: "dependency:payments", kind: "resource" },
      { name: "POST /orders", fullyQualifiedName: "POST /orders", kind: "resource" },
    ]);
    expect(storm.level).toBe("error");
  });
});
