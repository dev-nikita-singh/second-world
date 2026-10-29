/**
 * Real sanity check: run the API Bug Hunter against shop-express (same setup as
 * tests/integration/bugs/shop-express.test.ts) and render the result in every report
 * format. Verifies the renderers cope with real BugsData and never print credentials.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { type BugsData, runBugHunt } from "../../../src/engines/bugs/index.js";
import { cellOf, isBugsData, techniqueColumns } from "../../../src/engines/reporting/bugs.js";
import { REPORT_FORMATS, renderReport, writeReports } from "../../../src/engines/reporting/index.js";
import { type RunningExample, startExample } from "../../helpers/examples.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

const TOKENS = ["alice-token", "bob-token", "admin-token"];

let app: RunningExample;
let result: EngineResult<BugsData>;
let tmp: TmpDir;

beforeAll(async () => {
  app = await startExample("shop-express");
  tmp = await makeTmpDir("sw-bugs-report-");
  result = await runBugHunt(
    {
      target: app.url,
      openapi: "examples/shop-express/openapi.yaml",
      seed: 42,
      allowMutations: true,
      auth: {
        roles: {
          user: { type: "bearer", token: "alice-token" },
          other: { type: "bearer", token: "bob-token" },
          admin: { type: "bearer", token: "admin-token" },
        },
      },
      hooks: { reset: { http: { method: "POST", url: `${app.url}/__test/reset` } } },
      concurrency: [
        {
          name: "last item sold once",
          operation: "POST /orders",
          burst: 5,
          role: "user",
          body: { items: [{ productId: 20, qty: 1 }] },
          invariant: { kind: "linearizable", model: "stock", initial: 1 },
        },
      ],
    },
    { seed: 42 },
  );
}, 120_000);

afterAll(async () => {
  await app?.close();
  await tmp?.cleanup();
});

describe("Bug Hunter result rendered in every format (shop-express)", () => {
  it("the run produced real BugsData with reproductions", () => {
    expect(isBugsData(result.data)).toBe(true);
    const d = result.data as BugsData;
    expect(d.matrix.length).toBeGreaterThan(3);
    expect(d.findings.some((f) => f.ruleId === "bugs/bola")).toBe(true);
    expect(Object.keys(d.reproductions).length).toBeGreaterThan(0);
  });

  it("renders tty/md/html/junit/sarif/json without leaking any token", () => {
    for (const fmt of REPORT_FORMATS) {
      const out = renderReport([result], fmt, { color: false, meta: { runId: "bugs-sanity" } });
      expect(out.length, fmt).toBeGreaterThan(200);
      for (const t of TOKENS) expect(out, `${fmt} leaks ${t}`).not.toContain(t);
    }
  });

  it("tty shows matrix, coverage, findings and $SW_AUTH curl reproductions", () => {
    const s = renderReport([result], "tty", { color: false });
    expect(s).toContain("Matrix (passed/cases per operation × technique)");
    expect(s).toContain("GET /orders/{id}");
    expect(s).toContain("operations exercised");
    expect(s).toContain("bugs/bola");
    expect(s).toContain("Reproductions");
    expect(s).toMatch(/\$SW_AUTH_[A-Z]+/);
  });

  it("junit has exactly one testcase per operation × technique cell and fails the BOLA cell", () => {
    const d = result.data as BugsData;
    let cells = 0;
    for (const row of d.matrix) for (const t of techniqueColumns(d)) if (cellOf(row, t)) cells++;
    const xml = renderReport([result], "junit");
    expect([...xml.matchAll(/<testcase /g)]).toHaveLength(cells);
    expect(xml).toMatch(/<failure message="[^"]*bugs\/bola/);
  });

  it("sarif: every bug result carries the operation as a logical location", () => {
    const sarif = JSON.parse(renderReport([result], "sarif"));
    const results = sarif.runs[0].results as any[];
    expect(results.length).toBe(result.findings.length);
    for (const r of results) {
      expect(r.ruleId).toMatch(/^bugs\//);
      expect(r.locations[0].logicalLocations[0].name).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \//);
    }
  });

  it("writeReports writes all file formats", async () => {
    const { files } = await writeReports([result], { formats: [...REPORT_FORMATS], outDir: tmp.path });
    expect(files.map((f) => f.format)).toEqual(["json", "md", "junit", "sarif", "html"]);
    const html = readFileSync(tmp.join("report.html"), "utf8");
    expect(html).toContain("<pre><code>curl");
    expect(html).not.toMatch(/<script|\s(src|href)\s*=/i);
  });
});
