import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderReport, writeReports } from "../../../src/engines/reporting/index.js";
import { writeFileAtomic } from "../../../src/engines/reporting/json.js";
import { xmlEscape } from "../../../src/engines/reporting/junit.js";
import { makeFinding, makePerfData, makeResult, makeThreshold } from "../../fixtures/reports.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

/**
 * Minimal XML well-formedness check (no XML parser dependency): prolog, balanced
 * tags, quoted attributes, no raw '<' or bare '&' in text/attributes.
 */
function assertWellFormedXml(xml: string): void {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
  const body = xml.slice(xml.indexOf("?>") + 2);
  const stack: string[] = [];
  const tagRe = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.-]*="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  for (let m = tagRe.exec(body); m; m = tagRe.exec(body)) {
    const text = body.slice(last, m.index);
    expect(text, "raw < in text").not.toContain("<");
    expect(/&(?!(amp|lt|gt|quot|apos);)/.test(text), `bare & in: ${text}`).toBe(false);
    for (const a of (m[3] ?? "").matchAll(/="([^"]*)"/g)) expect(/&(?!(amp|lt|gt|quot|apos);)/.test(a[1] ?? "")).toBe(false);
    const [, close, name, , selfClose] = m;
    if (close) expect(stack.pop(), `unbalanced </${name}>`).toBe(name);
    else if (!selfClose) stack.push(name ?? "");
    last = m.index + m[0].length;
  }
  expect(body.slice(last).trim()).toBe("");
  expect(stack).toEqual([]);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: XML-invalid control chars
  expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)).toBe(false);
}

const nasty = 'quote" apos\' amp& lt< gt> ctrl\u0001\u0008 ok';

describe("junit renderer", () => {
  it("thresholds become test cases; failures counted; XML well-formed", () => {
    const r = makeResult({
      status: "failed",
      data: makePerfData({ thresholds: [makeThreshold({ passed: false, actual: 412 }), makeThreshold({ expression: "http.error_rate < 1%", unit: "ratio", actual: 0.001 })] }),
      findings: [makeFinding({ classification: "threshold-breach", severity: "high" })],
    });
    const xml = renderReport([r], "junit");
    assertWellFormedXml(xml);
    expect(xml).toContain('<testsuites name="second-world run-1" tests="2" failures="1" errors="0" skipped="0" time="12.500">');
    expect(xml).toContain('<testsuite name="second-world.performance" tests="2" failures="1"');
    expect(xml).toContain('<testcase name="http.p95 &lt; 300ms" classname="performance.thresholds">');
    expect(xml).toContain('<failure message="http.p95 &lt; 300ms failed: actual 412ms" type="threshold-breach">');
    expect(xml).toContain("<system-out>actual: 0.10%</system-out>");
  });

  it("findings: failing at fail-on → <failure>, below → passing case; nasty text escaped", () => {
    const r = makeResult({
      engine: "bugs",
      findings: [
        makeFinding({ id: "a", severity: "critical", classification: "reproduced-defect", title: nasty, description: nasty, locations: [{ file: "src/x.ts", line: 4 }] }),
        makeFinding({ id: "b", severity: "low", classification: "reproduced-defect", title: "minor" }),
      ],
    });
    const xml = renderReport([r], "junit", { failOn: "high" });
    assertWellFormedXml(xml);
    expect(xml).toContain('tests="2" failures="1"');
    expect(xml).toContain("quote&quot; apos&apos; amp&amp; lt&lt; gt&gt; ctrl ok");
    expect(xml).toContain("at src/x.ts:4");
    expect(xml).toContain('<testcase name="[low] minor" classname="bugs.performance"/>');
  });

  it("error / cancelled / empty results", () => {
    const xml = renderReport(
      [makeResult({ engine: "stress", status: "error" }), makeResult({ engine: "agent", status: "cancelled" }), makeResult({ engine: "architecture" })],
      "junit",
    );
    assertWellFormedXml(xml);
    expect(xml).toContain('errors="1"');
    expect(xml).toContain('<skipped message="cancelled by user (partial results)"/>');
    expect(xml).toContain('<testcase name="engine run" classname="architecture.engine"/>');
  });

  it("xmlEscape", () => {
    expect(xmlEscape(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
    expect(xmlEscape("tab\tnl\ncr\r\u0000￾")).toBe("tab\tnl\ncr\r");
    expect(xmlEscape("emoji 😀")).toBe("emoji 😀");
  });
});

describe("writeReports / writeFileAtomic", () => {
  let tmp: TmpDir;
  beforeEach(async () => {
    tmp = await makeTmpDir("sw-report-");
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it("writes json, md and junit (tty skipped) and creates outDir", async () => {
    const out = tmp.join("nested", "reports");
    const { files, report } = await writeReports([makeResult({ data: makePerfData() })], {
      formats: ["tty", "json", "md", "junit", "json"],
      outDir: out,
      meta: { runId: "W1" },
    });
    expect(files.map((f) => f.format)).toEqual(["json", "md", "junit"]);
    expect(files.map((f) => path.basename(f.path))).toEqual(["report.json", "report.md", "report.junit.xml"]);
    expect(JSON.parse(readFileSync(path.join(out, "report.json"), "utf8")).runId).toBe("W1");
    expect(report.verdict.exitCode).toBe(0);
    expect(readdirSync(out).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("overwrites an existing file atomically", async () => {
    const f = tmp.join("a.json");
    await writeFileAtomic(f, "one");
    await writeFileAtomic(f, "two");
    expect(readFileSync(f, "utf8")).toBe("two");
  });

  it("retries rename on EPERM/EBUSY (Windows) and then succeeds", async () => {
    const f = tmp.join("b.json");
    let calls = 0;
    const { rename } = await import("node:fs/promises");
    await writeFileAtomic(f, "data", {
      retryDelayMs: 1,
      renameImpl: async (a, b) => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("busy"), { code: calls === 1 ? "EPERM" : "EBUSY" });
        await rename(a, b);
      },
    });
    expect(calls).toBe(3);
    expect(readFileSync(f, "utf8")).toBe("data");
  });

  it("gives up after retries / on non-retryable errors and removes the temp file", async () => {
    const f = tmp.join("c.json");
    const fail = (code: string) => async () => {
      throw Object.assign(new Error(code), { code });
    };
    await expect(writeFileAtomic(f, "x", { retries: 3, retryDelayMs: 1, renameImpl: fail("EBUSY") })).rejects.toThrow("EBUSY");
    await expect(writeFileAtomic(f, "x", { renameImpl: fail("ENOSPC") })).rejects.toThrow("ENOSPC");
    expect(existsSync(f)).toBe(false);
    expect(readdirSync(tmp.path)).toEqual([]);
  });
});
