import { describe, expect, it } from "vitest";
import { renderReport } from "../../../src/engines/reporting/index.js";
import { mdEscape } from "../../../src/engines/reporting/markdown.js";
import { combineResults } from "../../../src/engines/reporting/model.js";
import { resolveAscii, resolveColor } from "../../../src/engines/reporting/tty.js";
import { makeFinding, makePerfData, makeResult, makeThreshold } from "../../fixtures/reports.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI detection
const ANSI = /\u001b\[/;

const perfOk = () => makeResult({ data: makePerfData() });
const perfFail = () =>
  makeResult({
    status: "failed",
    data: makePerfData({
      thresholds: [
        makeThreshold({ passed: false, actual: 412.5, expression: "http.p95 < 300ms" }),
        makeThreshold({
          expression: "http.error_rate < 5%",
          metric: "http.error_rate",
          unit: "ratio",
          threshold: 0.05,
          actual: 0.01,
        }),
      ],
    }),
    findings: [
      makeFinding({
        classification: "threshold-breach",
        severity: "high",
        title: 'Threshold "http.p95 < 300ms" breached',
      }),
    ],
    limitations: [
      { code: "generator-saturated", message: "Load generator saturated", impact: "reduces-confidence" },
    ],
  });

describe("tty renderer", () => {
  it("plain mode has no ANSI codes and shows the key perf numbers (corrected + raw)", () => {
    const s = renderReport([perfOk()], "tty", { color: false, meta: { runId: "R1", toolVersion: "0.1.0" } });
    expect(s).not.toMatch(ANSI);
    expect(s).toContain("SECOND WORLD");
    expect(s).toContain("run R1");
    expect(s).toContain("PASS");
    expect(s).toContain("exit 0");
    expect(s).toContain("[performance]");
    expect(s).toContain("1000"); // requests
    expect(s).toContain("50.0ms"); // corrected p50
    expect(s).toContain("90.0ms"); // corrected p95
    expect(s).toContain("48.0ms"); // raw p50
    expect(s).toContain("raw (uncorrected) latency");
    expect(s).toContain("GET /fixed/50");
    expect(s).toContain("1.00%"); // error rate
    expect(s).toContain("target 100/s");
    expect(s).toContain("http.p95 < 300ms");
  });

  it("colour mode emits ANSI", () => {
    expect(renderReport([perfOk()], "tty", { color: true })).toMatch(ANSI);
  });

  it("FAIL verdict lists breached thresholds, findings and limitations", () => {
    const s = renderReport([perfFail()], "tty", { color: false });
    expect(s).toContain("FAIL");
    expect(s).toContain("exit 1");
    expect(s).toContain("1 threshold(s) breached");
    expect(s).toContain("413ms");
    expect(s).toContain("Findings (1)");
    expect(s).toContain("threshold-breach");
    expect(s).toContain("generator-saturated");
  });

  it("ASCII mode uses only ASCII characters", () => {
    const s = renderReport(
      [
        perfFail(),
        makeResult({
          engine: "bugs",
          findings: [makeFinding({ title: "BOLA on orders", locations: [{ file: "src/a.ts", line: 3 }] })],
        }),
      ],
      "tty",
      {
        color: false,
        ascii: true,
      },
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ascii check
    expect(s).toMatch(/^[\u0000-\u007f]*$/);
    expect(s).toContain("FAIL");
    expect(s).toContain("src/a.ts:3");
  });

  it("generic engine results render without data", () => {
    const s = renderReport(makeResult({ engine: "architecture", data: { whatever: 1 } }), "tty", {
      color: false,
    });
    expect(s).toContain("[architecture]");
    expect(s).toContain("passed");
  });

  it("resolveColor honours NO_COLOR / FORCE_COLOR / TTY / TERM=dumb", () => {
    expect(resolveColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(resolveColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
    expect(resolveColor({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(resolveColor({ FORCE_COLOR: "0" }, false)).toBe(false);
    expect(resolveColor({}, true)).toBe(true);
    expect(resolveColor({}, false)).toBe(false);
    expect(resolveColor({ TERM: "dumb" }, true)).toBe(false);
    expect(resolveAscii({ TERM: "dumb" })).toBe(true);
    expect(resolveAscii({ SW_ASCII: "1" })).toBe(true);
    expect(resolveAscii({})).toBe(false);
  });
});

describe("markdown renderer", () => {
  it("renders verdict header, tables and methods", () => {
    const md = renderReport([perfFail()], "md", { meta: { runId: "R2", command: "sw perf --rate 100" } });
    expect(md.startsWith("## SECOND WORLD — ❌ FAIL\n")).toBe(true);
    expect(md).toContain("| run | status | duration | exit code | fail-on | version |");
    expect(md).toContain("| `R2` | failed | 12.5s | 1 | high | unknown |");
    expect(md).toContain("| ❌ | `http.p95 < 300ms` | 413ms |");
    expect(md).toContain("| ✅ | `http.error_rate < 5%` | 1.00% |");
    expect(md).toContain("<details><summary>Methods &amp; reproduction</summary>");
    expect(md).toContain("Reproduce: `sw perf --rate 100`");
    expect(md).toContain("**Limitations**");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("PASS header and escaping of table-breaking characters", () => {
    const md = renderReport(
      [
        makeResult({
          engine: "bugs",
          findings: [makeFinding({ severity: "low", title: "a | b <script> *x*" })],
        }),
      ],
      "md",
    );
    expect(md.startsWith("## SECOND WORLD — ✅ PASS")).toBe(true);
    expect(md).toContain("a \\| b &lt;script&gt; \\*x\\*");
    expect(mdEscape("line1\nline2")).toBe("line1 line2");
  });
});

describe("json renderer", () => {
  it("is the canonical combined report and round-trips", () => {
    const s = renderReport([perfOk()], "json", { meta: { runId: "R3" } });
    const parsed = JSON.parse(s);
    expect(parsed.kind).toBe("second-world-report");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.runId).toBe("R3");
    expect(parsed.verdict.exitCode).toBe(0);
    expect(parsed.results[0].data.totals.requests).toBe(1000);
    expect(s.endsWith("\n")).toBe(true);
  });

  it("non-finite numbers become null", () => {
    const s = renderReport([makeResult({ data: { x: Number.NaN, y: Number.POSITIVE_INFINITY } })], "json");
    expect(JSON.parse(s).results[0].data).toEqual({ x: null, y: null });
  });

  it("re-rendering a CombinedReport with another failOn recomputes the verdict", () => {
    const rep = combineResults([
      makeResult({ findings: [makeFinding({ severity: "medium", classification: "reproduced-defect" })] }),
    ]);
    expect(rep.verdict.exitCode).toBe(0);
    expect(JSON.parse(renderReport(rep, "json", { failOn: "medium" })).verdict.exitCode).toBe(1);
    expect(JSON.parse(renderReport(rep, "json")).verdict.exitCode).toBe(0);
  });
});
