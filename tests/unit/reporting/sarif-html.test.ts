import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { htmlEscape, svgSparkline } from "../../../src/engines/reporting/html.js";
import { REPORT_FORMATS, renderReport, writeReports } from "../../../src/engines/reporting/index.js";
import { combineResults } from "../../../src/engines/reporting/model.js";
import { buildSarif, sarifLevel, toUri } from "../../../src/engines/reporting/sarif.js";
import {
  makeComparison,
  makeFinding,
  makePerfData,
  makeResult,
  makeStressData,
} from "../../fixtures/reports.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

const XSS = `<script>alert("x")</script> & 'q'`;

const archFinding = makeFinding({
  id: "a1",
  fingerprint: "fp-arch",
  engine: "architecture",
  category: "architecture",
  ruleId: "arch/module-cycle",
  severity: "low",
  classification: "observation",
  title: "Module cycle",
  description: "inventory.ts <-> orders.ts",
  locations: [{ file: "src\\services\\inventory.ts", line: 4, column: 1, endLine: 4, symbol: "reserve" }],
});
const secFinding = makeFinding({
  id: "s1",
  fingerprint: "fp-bola",
  engine: "bugs",
  category: "security",
  ruleId: "bugs/bola",
  severity: "critical",
  classification: "reproduced-defect",
  title: "BOLA on GET /orders/{id}",
  affected: ["GET /orders/{id}"],
});
const perfFinding = makeFinding({
  id: "p1",
  fingerprint: "fp-p",
  severity: "high",
  classification: "threshold-breach",
  title: "p95 breached",
});

/**
 * Structural SARIF 2.1.0 validation of the parts consumers (GitHub code scanning,
 * VS Code SARIF viewer) rely on. Mirrors required properties of the OASIS schema.
 */
function validateSarif(doc: any): string[] {
  const errs: string[] = [];
  const req = (cond: unknown, msg: string) => {
    if (!cond) errs.push(msg);
  };
  req(doc.version === "2.1.0", "version must be 2.1.0");
  req(typeof doc.$schema === "string" && doc.$schema.includes("sarif-2.1.0"), "$schema");
  req(Array.isArray(doc.runs) && doc.runs.length >= 1, "runs[]");
  for (const run of doc.runs ?? []) {
    const driver = run.tool?.driver;
    req(typeof driver?.name === "string" && driver.name.length > 0, "tool.driver.name");
    const rules: any[] = driver?.rules ?? [];
    const ruleIds = new Set(rules.map((r) => r.id));
    req(ruleIds.size === rules.length, "rule ids unique");
    for (const r of rules) {
      req(typeof r.id === "string" && r.id.length > 0, "rule.id");
      req(["none", "note", "warning", "error"].includes(r.defaultConfiguration?.level), `rule ${r.id} level`);
    }
    req(Array.isArray(run.results), "run.results[]");
    for (const res of run.results ?? []) {
      req(typeof res.message?.text === "string" && res.message.text.length > 0, "result.message.text");
      req(ruleIds.has(res.ruleId), `result.ruleId ${res.ruleId} declared in rules`);
      req(["none", "note", "warning", "error"].includes(res.level), "result.level");
      for (const loc of res.locations ?? []) {
        const pl = loc.physicalLocation;
        req(pl || loc.logicalLocations, "location has physical or logical location");
        if (pl) {
          const uri: string = pl.artifactLocation?.uri;
          req(typeof uri === "string" && uri.length > 0, "artifactLocation.uri");
          req(
            !uri.includes("\\") && !/^[A-Za-z]:/.test(uri) && !uri.startsWith("/"),
            `uri relative POSIX: ${uri}`,
          );
          req(Number.isInteger(pl.region?.startLine) && pl.region.startLine >= 1, "region.startLine >= 1");
        }
      }
    }
  }
  return errs;
}

describe("SARIF 2.1.0", () => {
  const report = combineResults(
    [
      makeResult({ engine: "architecture", findings: [archFinding] }),
      makeResult({ engine: "bugs", findings: [secFinding] }),
      makeResult({ findings: [perfFinding] }),
    ],
    { runId: "S1", toolVersion: "0.1.0", command: "sw inspect" },
  );
  const sarif = JSON.parse(renderReport(report, "sarif"));

  it("is structurally valid", () => {
    expect(validateSarif(sarif)).toEqual([]);
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver).toMatchObject({
      name: "SECOND WORLD",
      version: "0.1.0",
      semanticVersion: "0.1.0",
    });
    expect(sarif.runs[0].automationDetails.id).toBe("second-world/S1");
  });

  it("code findings → physicalLocation with relative POSIX uri, region and symbol", () => {
    const r = sarif.runs[0].results.find((x: any) => x.ruleId === "arch/module-cycle");
    expect(r.level).toBe("note");
    expect(r.message.text).toBe("Module cycle — inventory.ts <-> orders.ts");
    expect(r.locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: "src/services/inventory.ts", uriBaseId: "%SRCROOT%" },
      region: { startLine: 4, startColumn: 1, endLine: 4 },
    });
    expect(r.locations[0].logicalLocations).toEqual([{ name: "reserve", kind: "function" }]);
    expect(r.partialFingerprints).toEqual({ "secondWorld/v1": "fp-arch" });
  });

  it("non-code findings → logicalLocations; security rules get security-severity; fallback ruleId", () => {
    const r = sarif.runs[0].results.find((x: any) => x.ruleId === "bugs/bola");
    expect(r.level).toBe("error");
    expect(r.locations[0].logicalLocations[0]).toEqual({
      name: "GET /orders/{id}",
      fullyQualifiedName: "GET /orders/{id}",
      kind: "resource",
    });
    const rule = sarif.runs[0].tool.driver.rules.find((x: any) => x.id === "bugs/bola");
    expect(rule.properties["security-severity"]).toBe("9.5");
    expect(rule.properties.tags).toContain("security");
    const p = sarif.runs[0].results.find((x: any) => x.properties.findingId === "p1");
    expect(p.ruleId).toBe("performance/performance");
    expect(p.locations).toBeUndefined();
    // ordered strongest first
    expect(sarif.runs[0].results[0].properties.findingId).toBe("s1");
  });

  it("level mapping and uri normalisation", () => {
    expect(["critical", "high", "medium", "low", "info"].map((s) => sarifLevel(s as never))).toEqual([
      "error",
      "error",
      "warning",
      "note",
      "note",
    ]);
    expect(toUri("./src/a b/c#d.ts")).toBe("src/a%20b/c%23d.ts");
    expect(toUri("src\\x\\y.ts")).toBe("src/x/y.ts");
  });

  it("empty report is still valid", () => {
    const doc = buildSarif(combineResults([makeResult()]));
    expect(validateSarif(doc)).toEqual([]);
    expect((doc.runs as any[])[0].results).toEqual([]);
  });
});

describe("HTML", () => {
  const html = renderReport(
    [
      makeResult({
        data: makePerfData({
          series: [1, 2, 3, 4].map((t) => ({
            t,
            requests: 100,
            ok: 100,
            failed: 0,
            rps: 100 + t,
            bytesIn: 0,
            p50: 10,
            p95: 20 + t * 5,
            p99: 40,
            max: 50,
          })),
        }),
        findings: [
          makeFinding({
            title: XSS,
            severity: "high",
            classification: "reproduced-defect",
            recommendation: "fix <it>",
          }),
        ],
        limitations: [{ code: "x<y", message: XSS, impact: "invalidates" }],
      }),
      makeResult({ engine: "stress", data: makeStressData() }),
      makeResult({ engine: "history", data: makeComparison() }),
    ],
    "html",
    { meta: { runId: `R"<1>`, command: "sw perf <x>" } },
  );

  it("is a single self-contained document with no scripts and no external requests", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<(img|iframe|object|embed|video|audio|source)\b/i);
    expect(html).not.toMatch(/\s(src|href|action|srcset|poster)\s*=/i);
    expect(html).not.toMatch(/url\(|@import/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // no inline event handlers
  });

  it("escapes all content", () => {
    expect(html).not.toContain(XSS);
    expect(html).toContain(htmlEscape(XSS));
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;");
    expect(html).toContain("R&quot;&lt;1&gt;");
    expect(html).toContain("<code>sw perf &lt;x&gt;</code>");
    expect(html).toContain("fix: fix &lt;it&gt;");
    expect(html).toContain("<code>x&lt;y</code>");
  });

  it("supports light and dark via prefers-color-scheme", () => {
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
  });

  it("renders perf, stress and history sections with inline SVG sparklines", () => {
    expect(html).toContain("FAIL"); // failing high finding
    expect(html).toContain("<h2>performance");
    expect(html).toContain("<h2>stress");
    expect(html).toContain("<h2>history");
    expect(html.match(/<svg class="spark"/g)?.length).toBe(3); // perf p95 + rps, stress p95
    expect(html).toContain("worse (no statistics)");
    expect(html).toContain('class="estimate"');
    expect(html).toContain("raw (uncorrected)");
  });

  it("svgSparkline scales points into the box and ignores non-finite values", () => {
    const s = svgSparkline([0, 10, Number.NaN, 5], "t<", 100, 20);
    expect(s).toContain('<polyline points="2.0,18.0 34.0,2.0 98.0,10.0"/>');
    expect(s).toContain("<title>t&lt;</title>");
    expect(svgSparkline([1], "x")).toBe("");
  });
});

describe("format list and writeReports", () => {
  let tmp: TmpDir;
  beforeEach(async () => {
    tmp = await makeTmpDir("sw-fmt-");
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it("REPORT_FORMATS lists every supported format", () => {
    expect([...REPORT_FORMATS]).toEqual(["tty", "json", "md", "junit", "sarif", "html"]);
  });

  it("writes .sarif and .html files", async () => {
    const { files } = await writeReports([makeResult({ engine: "architecture", findings: [archFinding] })], {
      formats: ["sarif", "html"],
      outDir: tmp.path,
    });
    expect(files.map((f) => path.basename(f.path))).toEqual(["report.sarif", "report.html"]);
    expect(validateSarif(JSON.parse(readFileSync(tmp.join("report.sarif"), "utf8")))).toEqual([]);
    expect(readFileSync(tmp.join("report.html"), "utf8")).toContain("Module cycle");
  });
});
