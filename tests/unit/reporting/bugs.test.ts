import { describe, expect, it } from "vitest";
import { isBugsData, replayText, scrubSecrets } from "../../../src/engines/reporting/bugs.js";
import { renderReport } from "../../../src/engines/reporting/index.js";
import { makeBugsData, makeFinding, makeResult, makeStressData } from "../../fixtures/reports.js";

const findingsFor = () => [
  makeFinding({ id: "b-1", fingerprint: "fp-bola", engine: "bugs", category: "security", ruleId: "bugs/bola", severity: "critical", classification: "reproduced-defect", title: "BOLA: other user can read order", affected: ["GET /orders/{id}"] }),
  makeFinding({ id: "b-2", fingerprint: "fp-boundary", engine: "bugs", category: "bug", ruleId: "bugs/server-error-on-boundary", severity: "medium", classification: "reproduced-defect", title: "500 on qty=0", affected: ["POST /orders"] }),
  makeFinding({ id: "b-3", fingerprint: "fp-flaky", engine: "bugs", category: "bug", ruleId: "bugs/race-lost-update", severity: "high", classification: "reproduced-defect", title: "Oversell under concurrency", affected: ["POST /orders"] }),
];
const bugsResult = (data = makeBugsData()) => makeResult({ engine: "bugs", status: "failed", data, findings: findingsFor() });

const LEAKS = ["alice-token", "abc123", "s3cr3t"];

describe("bugs helpers", () => {
  it("guard", () => {
    expect(isBugsData(makeBugsData())).toBe(true);
    expect(isBugsData(makeStressData())).toBe(false);
    expect(isBugsData({ mode: "contract" })).toBe(false);
  });

  it("replayText: flaky k/n with Wilson CI, reproduced, not replayed", () => {
    const d = makeBugsData();
    expect(replayText(d.findings[2]!)).toBe("flaky 2/5 (Wilson 95% CI 11.80%–76.90%)");
    expect(replayText(d.findings[0]!)).toBe("reproduced 3/3 (Wilson 95% CI 43.90%–100.00%)");
    expect(replayText({ ...d.findings[0]!, replays: 0, classification: "observation" })).toBe("observed (not replayed)");
  });

  it("scrubSecrets keeps $SW_AUTH placeholders and redacts literal credentials", () => {
    expect(scrubSecrets(`-H 'Authorization: $SW_AUTH_USER'`)).toBe(`-H 'Authorization: $SW_AUTH_USER'`);
    expect(scrubSecrets(`-H 'Authorization: Bearer alice-token'`)).toBe(`-H 'Authorization: Bearer [REDACTED]'`);
    expect(scrubSecrets(`-H "authorization: Basic YWxpY2U6cA=="`)).toBe(`-H "authorization: Basic [REDACTED]"`);
    expect(scrubSecrets(`-H 'Cookie: sid=s3cr3t; x=1'`)).toBe(`-H 'Cookie: [REDACTED]'`);
    expect(scrubSecrets(`-H 'X-Api-Key: k1'`)).toBe(`-H 'X-Api-Key: [REDACTED]'`);
    expect(scrubSecrets(`curl -u alice:pw http://h/`)).toBe(`curl -u [REDACTED] http://h/`);
    expect(scrubSecrets(`'http://h/x?a=1&token=abc123&b=2'`)).toBe(`'http://h/x?a=1&token=[REDACTED]&b=2'`);
  });
});

describe("bugs rendering — tty", () => {
  const s = renderReport([bugsResult()], "tty", { color: false });

  it("matrix: operation × technique with passed/cases, failures and inconclusive", () => {
    expect(s).toContain("Matrix (passed/cases per operation × technique)");
    for (const col of ["operation", "verdict", "contract", "boundary", "auth", "concurrency", "statuses"]) expect(s).toContain(col);
    expect(s).toContain("1/3 ✗2");
    expect(s).toContain("4/6 ✗2");
    expect(s).toContain("0/1 ?1");
    expect(s).toContain("cells: passed/cases, ✗ failed cases, ? inconclusive, - not run.");
    expect(s).toContain("FAIL");
    expect(s).toContain("untested");
    expect(s).toContain("500x2!"); // undocumented status marked
    expect(s).toContain("not documented in the contract");
  });

  it("coverage", () => {
    expect(s).toMatch(/operations exercised\s+2\/3/);
    expect(s).toMatch(/statuses observed \/ documented\s+4\/6/);
    expect(s).toMatch(/coverage ratio\s+66\.67%/);
    expect(s).toContain("contract 4, boundary 6, auth 3, concurrency 1");
  });

  it("findings with classification and flaky k/n (Wilson CI), defects first by severity", () => {
    expect(s).toContain("Bug findings (3)");
    expect(s).toContain("reproduced-defect");
    expect(s).toContain("flaky 2/5 (Wilson 95% CI 11.80%–76.90%)");
    expect(s).toContain("2x (minimized)");
    const i = (t: string) => s.indexOf(t, s.indexOf("Bug findings"));
    expect(i("BOLA")).toBeLessThan(i("Oversell"));
    expect(i("Oversell")).toBeLessThan(i("500 on qty=0"));
  });

  it("reproductions show curl with $SW_AUTH placeholders and never tokens", () => {
    expect(s).toContain("Reproductions");
    expect(s).toContain("export SW_AUTH_<ROLE>");
    expect(s).toContain('-H "Authorization: $SW_AUTH_OTHER"');
    expect(s).toContain("bugs/bola on GET /orders/{id} (seed 42) — other user got 200");
    for (const leak of LEAKS) expect(s).not.toContain(leak);
  });

  it("discovery mode shows the draft-contract note; contract mode does not", () => {
    expect(s).not.toContain("Discovery mode");
    const disc = renderReport(
      [bugsResult(makeBugsData({ mode: "discovery", contract: undefined, draftContract: { openapi: "3.1.0", paths: { "/a": {}, "/b": {} } } }))],
      "tty",
      { color: false },
    );
    expect(disc).toContain("Discovery mode: no contract was given");
    expect(disc).toContain("(2 paths)");
    expect(disc).toContain("data.draftContract");
    expect(disc).toContain("none (discovery mode)");
  });

  it("limits printed reproductions", () => {
    const t = renderReport([bugsResult(makeBugsData())], "tty", { color: false });
    expect(t.match(/curl -sS/g)?.length).toBe(3);
  });
});

describe("bugs rendering — md / html / json", () => {
  it("markdown: tables, fenced sh blocks, no tokens", () => {
    const md = renderReport([bugsResult()], "md");
    expect(md).toContain("| operation | verdict | contract | boundary | auth | concurrency | statuses |");
    expect(md).toContain("| GET /orders/{id} | FAIL |");
    expect(md).toContain("```sh\ncurl -sS -X POST 'http://127.0.0.1:3000/orders' -H \"Authorization: $SW_AUTH_USER\"");
    expect(md).toContain("flaky 2/5 (Wilson 95% CI 11.80%–76.90%)");
    for (const leak of LEAKS) expect(md).not.toContain(leak);
  });

  it("html: escaped <pre> curl blocks, matrix table, no tokens, still self-contained", () => {
    const html = renderReport([bugsResult()], "html");
    expect(html).toContain("<pre><code>curl -sS -X POST &#39;http://127.0.0.1:3000/orders&#39; -H &quot;Authorization: $SW_AUTH_USER&quot;");
    expect(html).toContain("\ncurl -sS -X GET &#39;http://127.0.0.1:3000/orders/ord_1&#39; -H &quot;Authorization: $SW_AUTH_OTHER&quot;</code></pre>");
    expect(html).toContain("<h4>Matrix (passed/cases per operation × technique)</h4>");
    expect(html).toContain("flaky 2/5");
    for (const leak of LEAKS) expect(html).not.toContain(leak);
    expect(html).not.toMatch(/<script|\s(src|href)\s*=/i);
  });

  it("json keeps BugsData intact (machine-readable) inside the canonical report", () => {
    const j = JSON.parse(renderReport([bugsResult()], "json"));
    expect(j.results[0].data.matrix).toHaveLength(3);
    expect(j.results[0].data.coverage.ratio).toBeCloseTo(0.6667);
    expect(j.results[0].data.findings[2]).toMatchObject({ flaky: true, failures: 2, replays: 5 });
  });
});

describe("bugs rendering — junit", () => {
  const xml = renderReport([bugsResult()], "junit", { failOn: "high" });

  it("one testcase per operation × technique (finding cases not duplicated)", () => {
    const names = [...xml.matchAll(/<testcase name="([^"]+)" classname="([^"]+)"/g)].map((m) => `${m[2]}::${m[1]}`);
    expect(names).toEqual([
      "bugs.contract::GET /orders/{id} [contract]",
      "bugs.auth::GET /orders/{id} [auth]",
      "bugs.boundary::POST /orders [boundary]",
      "bugs.concurrency::POST /orders [concurrency]",
      "bugs.contract::GET /healthz [contract]",
    ]);
  });

  it("fails only cells with findings at or above fail-on; others pass/skip with details", () => {
    expect(xml).toContain('tests="5" failures="2" errors="0" skipped="2"');
    expect(xml).toContain('<failure message="2 of 3 case(s) failed: bugs/bola" type="reproduced-defect">[critical] bugs/bola: BOLA: other user can read order — reproduced 3/3');
    // boundary cell: race (high) fails at high; the medium 500 is below fail-on and not listed as failing
    expect(xml).toMatch(/<failure message="2 of 6 case\(s\) failed: bugs\/race-lost-update"/);
    expect(xml).toContain('<skipped message="inconclusive (1 case(s))"/>');
    expect(xml).toContain('<skipped message="no cases generated"/>');
    const crit = renderReport([bugsResult()], "junit", { failOn: "critical" });
    expect(crit).toContain('failures="1"');
    expect(crit).toContain("below fail-on: bugs/server-error-on-boundary (medium, reproduced-defect), bugs/race-lost-update (high, reproduced-defect)");
  });
});

describe("bugs rendering — sarif", () => {
  it("bug findings get the operation as logical location plus replay properties", () => {
    const sarif = JSON.parse(renderReport([bugsResult()], "sarif"));
    const results = sarif.runs[0].results as any[];
    expect(results).toHaveLength(3);
    const bola = results.find((r) => r.ruleId === "bugs/bola");
    expect(bola.locations).toEqual([{ logicalLocations: [{ name: "GET /orders/{id}", fullyQualifiedName: "GET /orders/{id}", kind: "resource" }] }]);
    expect(bola.properties).toMatchObject({ operation: "GET /orders/{id}", technique: "auth", replay: { failures: 3, replays: 3, flaky: false } });
    const flaky = results.find((r) => r.ruleId === "bugs/race-lost-update");
    expect(flaky.properties.replay).toMatchObject({ flaky: true, failures: 2, replays: 5 });
    expect(results.every((r) => !r.locations[0].physicalLocation)).toBe(true);
  });
});

describe("bugs rendering — ascii", () => {
  it("ascii mode folds matrix symbols", () => {
    const s = renderReport([bugsResult()], "tty", { color: false, ascii: true });
    expect(s).toContain("1/3 x2");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ascii check
    expect(s).toMatch(/^[\u0000-\u007f]*$/);
  });
});
