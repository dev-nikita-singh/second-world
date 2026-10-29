/**
 * Adversarial tests for suggested-test export (docs/03-engines/adversarial-test-agent.md §6):
 * code injection through JS line terminators in comments, and path traversal in exported file
 * names. Owner: sw-coverage (Wave 5).
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { exportSuggestedTests } from "../../../src/cli/commands/agent.js";
import { envNameFor, suggestedTest } from "../../../src/engines/agent/export.js";
import { parseScenario, type Scenario } from "../../../src/engines/agent/scenario.js";

function scenario(): Scenario {
  const p = parseScenario({
    title: "t",
    hypothesis: "h",
    steps: [{ operation: "GET /items" }],
    assertions: [{ kind: "status", step: 0, oneOf: [200] }],
    expectedClassification: "defect",
  });
  if (!p.ok) throw new Error("bad scenario");
  return (p as { scenario: Scenario }).scenario;
}

function exitCalls(text: string): number {
  const sf = ts.createSourceFile("t.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let calls = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.getText(sf).includes("exit")) calls++;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return calls;
}

const meta = (operation: string, ruleId = "agent/bola") => ({
  fingerprint: "fp",
  ruleId,
  operation,
  target: "http://127.0.0.1:1",
  roles: [null],
  requests: [{ method: "GET", path: "/items" }],
  credentials: {},
});

describe("suggested test code generation", () => {
  it("property: arbitrary operation/rule strings never become code", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.string({ maxLength: 30 }), (op, rule) => {
        const t = suggestedTest(scenario(), meta(`${op}\nprocess.exit(1)`, `${rule}\nprocess.exit(2)`));
        expect(exitCalls(t.vitest)).toBe(0);
        expect(t.filename).toMatch(/^agent-[a-z0-9-]+-[a-z0-9-]+\.test\.ts$/);
      }),
      { numRuns: 200 },
    );
  });

  // Regression (sw-coverage bug report, fixed by main): the header comment of the generated Vitest file embeds the operation and rule
  // id with JSON.stringify (src/engines/agent/export.ts:248), which does not escape U+2028/U+2029.
  // Both are JS LINE TERMINATORS, so inside a `//` comment they end the comment and the rest of an
  // untrusted OpenAPI operation name/path becomes executable code in the exported test file.
  it("U+2028 / U+2029 in an operation name cannot escape the header comment", () => {
    for (const sep of ["\u2028", "\u2029"]) {
      const t = suggestedTest(scenario(), meta(`GET /x${sep}process.exit(1)//`));
      expect(exitCalls(t.vitest)).toBe(0);
    }
  });

  it("env names are sanitised", () => {
    expect(envNameFor("ad-min.user")).toBe("SW_AUTH_AD_MIN_USER");
    fc.assert(
      fc.property(fc.string(), (r) => {
        expect(envNameFor(r)).toMatch(/^SW_AUTH_[A-Z0-9_]*$/);
      }),
    );
  });
});

describe("exportSuggestedTests: file names", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-export-cov-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("never writes outside the target directory", () => {
    const out = join(dir, "out");
    const hostile = [
      "../../evil.test.ts",
      "..\\..\\evil2.test.ts",
      "/etc/passwd",
      "C:\\Windows\\x.ts",
      "..",
      ".",
      "",
      "a/b/../../../c",
      "name with spaces & $(cmd)",
      "\u0000nul.ts",
    ];
    const written = exportSuggestedTests(
      out,
      hostile.map((filename) => ({ filename, vitest: "// x" })),
    );
    expect(written).toHaveLength(hostile.length);
    for (const p of written) {
      expect(dirname(p)).toBe(out);
      expect(p.endsWith(".ts")).toBe(true);
    }
    expect(readdirSync(dir)).toEqual(["out"]);
  });

  it("property: any file name lands directly in the directory", () => {
    const out = join(dir, "prop");
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (filename) => {
        const [p] = exportSuggestedTests(out, [{ filename, vitest: "" }]);
        expect(dirname(p as string)).toBe(out);
      }),
      { numRuns: 100 },
    );
    expect(readdirSync(dir).sort()).toEqual(["out", "prop"]);
  });
});
