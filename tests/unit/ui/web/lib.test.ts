/** Pure logic of the `sw ui` browser app (src/ui/web/lib): formatting, routing, forms, report parsing. */
import { describe, expect, it } from "vitest";
import type { EngineInfo } from "../../../../src/ui/shared/api-types.js";
import {
  checkOption,
  formErrors,
  initialValues,
  neededConfirmations,
  toRequest,
} from "../../../../src/ui/web/lib/form.js";
import {
  engineTitle,
  exitTone,
  fmtDuration,
  fmtMs,
  fmtNumber,
  fmtPct,
  fmtRelative,
  isCustomLabel,
  severityRank,
  statusTone,
} from "../../../../src/ui/web/lib/format.js";
import {
  countBySeverity,
  metricRows,
  parseReport,
  perfView,
  scalarFacts,
  stressView,
} from "../../../../src/ui/web/lib/report.js";
import { href, linkFromHash, parseRoute, tokenFromHash } from "../../../../src/ui/web/lib/route.js";

const RUN = "01M6Z90RJMX1MJMZ26VRG4C6Y4";

describe("format", () => {
  it("numbers, times and percentages read naturally", () => {
    expect(fmtNumber(1234.5)).toBe("1,235");
    expect(fmtNumber(12.34)).toBe("12.3");
    expect(fmtNumber(0.123)).toBe("0.12");
    expect(fmtNumber(undefined)).toBe("–");
    expect(fmtMs(4.567)).toBe("4.57 ms");
    expect(fmtMs(45.67)).toBe("45.7 ms");
    expect(fmtMs(456.7)).toBe("457 ms");
    expect(fmtMs(4567)).toBe("4.57 s");
    expect(fmtMs(45_670)).toBe("45.7 s");
    expect(fmtPct(0)).toBe("0%");
    expect(fmtPct(0.0005)).toBe("0.05%");
    expect(fmtPct(0.123)).toBe("12.3%");
    expect(fmtDuration(65_000)).toBe("1 min 05 s");
    expect(fmtDuration(400)).toBe("400 ms");
    expect(fmtDuration(3_720_000)).toBe("1 h 02 min");
  });

  it("relative time", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    expect(fmtRelative("2026-11-09T11:59:50Z", now)).toBe("just now");
    expect(fmtRelative("2026-11-09T11:55:00Z", now)).toBe("5 min ago");
    expect(fmtRelative("2026-11-09T09:00:00Z", now)).toBe("3 h ago");
    expect(fmtRelative("2026-11-08T10:00:00Z", now)).toBe("yesterday");
    expect(fmtRelative("2026-10-01T10:00:00Z", now)).toBe("2026-10-01");
  });

  it("words for engines, statuses, exits, severities and labels", () => {
    expect(engineTitle("architecture")).toBe("Code inspection");
    expect(engineTitle("unknown-x")).toBe("unknown-x");
    expect(statusTone("failed")).toEqual({ tone: "bad", label: "Problems found" });
    expect(statusTone("cancelled").tone).toBe("neutral");
    expect([0, 1, 2, 130].map(exitTone)).toEqual(["ok", "warn", "bad", "neutral"]);
    expect(["info", "critical", "high"].sort((a, b) => severityRank(a) - severityRank(b))).toEqual([
      "critical",
      "high",
      "info",
    ]);
    expect(isCustomLabel("bugs")).toBe(false);
    expect(isCustomLabel("before-fix")).toBe(true);
    expect(isCustomLabel(undefined)).toBe(false);
  });
});

describe("routes", () => {
  it("parses and builds hash routes", () => {
    expect(parseRoute("")).toEqual({ page: "dashboard" });
    expect(parseRoute("#/runs")).toEqual({ page: "runs" });
    expect(parseRoute(`#/runs/${RUN}`)).toEqual({ page: "run", id: RUN });
    expect(parseRoute(`#/runs/${RUN}?finding=abc123`)).toEqual({ page: "run", id: RUN, finding: "abc123" });
    expect(parseRoute("#/runs/not-a-run-id")).toEqual({ page: "runs" });
    expect(parseRoute("#/new/perf")).toEqual({ page: "new", engine: "perf" });
    expect(parseRoute("#/jobs/job-1")).toEqual({ page: "job", id: "job-1" });
    expect(parseRoute(`#/compare?baseline=${RUN}&current=${RUN}`)).toEqual({
      page: "compare",
      baseline: RUN,
      current: RUN,
    });
    expect(parseRoute("#/compare?baseline=x&current=y")).toEqual({ page: "runs" });
    expect(parseRoute("#/nope")).toEqual({ page: "dashboard" });
    for (const r of [
      { page: "runs" },
      { page: "run", id: RUN, finding: "f1" },
      { page: "new", engine: "bugs" },
      { page: "settings" },
    ] as const)
      expect(parseRoute(href(r))).toEqual(r);
  });

  it("reads the token (and an optional deep link) from the fragment only", () => {
    const t = "Q1l_rC3JndNf-J8cIC-B7Uzwoao-rH61XBgyiiJGpzs";
    expect(tokenFromHash(`#t=${t}`)).toBe(t);
    expect(linkFromHash(`#t=${t}`)).toEqual({ token: t, route: "#/" });
    expect(linkFromHash(`#t=${t}&r=/runs/${RUN}`)).toEqual({ token: t, route: `#/runs/${RUN}` });
    expect(tokenFromHash("#t=short")).toBeNull();
    expect(tokenFromHash(`#/runs?t=${t}`)).toBeNull();
    expect(linkFromHash(`#t=${t}&r=javascript:alert(1)`)).toBeNull();
    expect(parseRoute(`#t=${t}`)).toEqual({ page: "dashboard" });
  });
});

const ENGINE: EngineInfo = {
  id: "perf",
  title: "Load test",
  summary: "",
  typicalDuration: "",
  configured: true,
  needs: [],
  options: [
    { name: "rate", label: "Rate", help: "", kind: "number", min: 1, max: 100 },
    { name: "duration", label: "Duration", help: "", kind: "duration" },
    { name: "model", label: "Model", help: "", kind: "enum", choices: ["open", "closed"] },
    { name: "techniques", label: "T", help: "", kind: "multi", choices: ["a", "b"] },
    { name: "mut", label: "Mut", help: "", kind: "boolean", confirms: "mutations" },
    { name: "workers", label: "W", help: "", kind: "text" },
    { name: "scenario", label: "Scenario", help: "", kind: "enum", choices: ["only"], required: true },
  ],
};

describe("form", () => {
  it("initial values: empty means config default; a single required choice is preselected", () => {
    expect(initialValues(ENGINE)).toEqual({
      rate: "",
      duration: "",
      model: "",
      techniques: [],
      mut: false,
      workers: "",
      scenario: "only",
    });
  });

  it("checks like the server does", () => {
    const o = (n: string) => ENGINE.options.find((x) => x.name === n)!;
    expect(checkOption(o("rate"), "")).toBeNull();
    expect(checkOption(o("rate"), "abc")).toBe("Enter a number");
    expect(checkOption(o("rate"), "0")).toBe("At least 1");
    expect(checkOption(o("rate"), "500")).toBe("At most 100");
    expect(checkOption(o("duration"), "20 s")).toMatch(/Like/);
    expect(checkOption(o("duration"), "20s")).toBeNull();
    expect(checkOption(o("workers"), "a b")).toMatch(/no spaces/);
    expect(checkOption(o("scenario"), "")).toBe("Required");
    expect(formErrors(ENGINE, { ...initialValues(ENGINE), rate: "x" }, "bad label")).toEqual({
      rate: "Enter a number",
      __label: expect.any(String),
    });
  });

  it("builds the request and the confirmations it needs", () => {
    const v = { ...initialValues(ENGINE), rate: "50", duration: " 20s ", techniques: ["b"], mut: true };
    expect(toRequest(ENGINE, v, { dryRun: true, label: "x" })).toEqual({
      engine: "perf",
      options: { rate: 50, duration: "20s", techniques: ["b"], mut: true, scenario: "only" },
      dryRun: true,
      label: "x",
    });
    expect(neededConfirmations(ENGINE, v)).toEqual(["mutations"]);
    expect(neededConfirmations(ENGINE, initialValues(ENGINE))).toEqual([]);
  });
});

describe("report parsing", () => {
  const raw = {
    kind: "second-world-report",
    status: "failed",
    durationMs: 1200,
    verdict: { passed: false, exitCode: 1, reasons: ["1 finding at or above 'high'"] },
    results: [
      {
        engine: "bugs",
        status: "failed",
        startedAt: "2026-11-09T10:00:00.000Z",
        endedAt: "2026-11-09T10:00:01.500Z",
        findings: [
          {
            id: "f2",
            fingerprint: "bb",
            engine: "bugs",
            title: "Low thing",
            severity: "low",
            classification: "observation",
            evidence: [],
            locations: [],
            affected: ["GET /x"],
          },
          {
            id: "f1",
            fingerprint: "aa",
            engine: "bugs",
            ruleId: "bugs/bola",
            title: "BOLA",
            description: "bob read alice's order",
            severity: "critical",
            classification: "reproduced-defect",
            confidence: 0.95,
            evidence: [{ kind: "note", text: "n" }],
            locations: [{ file: "src/a.ts", line: 3 }],
            affected: [],
            recommendation: "check ownership",
          },
        ],
        limitations: [{ code: "X", message: "m", impact: "invalidates" }],
        data: {
          mode: "contract",
          durationMs: 1500,
          reproductions: { aa: { curl: ["curl a", "curl b"] } },
          nested: { x: 1 },
        },
      },
    ],
  };

  it("findings sorted by severity, with curl reproductions and locations", () => {
    const r = parseReport(raw);
    expect(r.status).toBe("failed");
    expect(r.verdict).toEqual({ passed: false, exitCode: 1, reasons: ["1 finding at or above 'high'"] });
    expect(r.findings.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(r.findings[0]).toMatchObject({
      where: "src/a.ts:3",
      curl: ["curl a", "curl b"],
      ruleId: "bugs/bola",
    });
    expect(r.findings[1]?.where).toBe("GET /x");
    expect(r.limitations).toEqual([{ engine: "bugs", code: "X", message: "m", impact: "invalidates" }]);
    expect(r.results[0]?.durationMs).toBe(1500);
    expect(countBySeverity(r.findings)).toEqual({ critical: 1, high: 0, medium: 0, low: 1, info: 0 });
    expect(scalarFacts(r.results[0]!.data)).toEqual([
      ["mode", "contract"],
      ["duration", "1.50 s"],
    ]);
  });

  it("survives garbage", () => {
    for (const g of [null, 1, "x", [], { results: "no" }, { results: [null, 1, { findings: [null] }] }]) {
      const r = parseReport(g);
      expect(Array.isArray(r.findings)).toBe(true);
    }
  });

  it("performance, stress and comparison views", () => {
    const p = perfView({
      target: "http://t",
      totals: { requests: 10, failed: 1, rps: 5, errorRate: 0.1 },
      latency: { corrected: { p50: 1, p95: 2, p99: 3, max: 4 } },
      endpoints: [{ key: "GET /", requests: 10, latency: { corrected: { p95: 2 } } }],
      series: [{ t: 1, p50: 1, p95: 2 }],
      thresholds: [{ expression: "p95<5ms", actual: 2, passed: true, unit: "ms" }],
    });
    expect(p).toMatchObject({
      requests: 10,
      p95: 2,
      endpoints: [{ key: "GET /", p95: 2 }],
      thresholds: [{ passed: true }],
    });
    expect(perfView({})).toBeNull();
    const s = stressView({
      loadType: "vus",
      capacity: { testedCapacity: 10, statement: "ok up to 10" },
      firstBreach: { expression: "p95<100ms", level: 20 },
      stages: [{ label: "10 VUs", level: 10, status: "ok", throughput: 50, errorRate: 0, breachReasons: [] }],
    });
    expect(s).toMatchObject({
      testedCapacity: 10,
      firstBreach: "p95<100ms at level 20",
      stages: [{ level: 10 }],
    });
    expect(stressView({})).toBeNull();
    expect(
      metricRows({
        metrics: [
          {
            metric: "performance.http.p95",
            baseline: 10,
            current: 12,
            relativeChange: 0.2,
            verdict: "regressed",
          },
        ],
      }),
    ).toEqual([
      { metric: "performance.http.p95", baseline: 10, current: 12, change: 0.2, verdict: "regressed" },
    ]);
  });
});
