import { describe, expect, it } from "vitest";
import { diffModels } from "../../../src/engines/model/diff.js";
import { renderModelDiff, renderReport } from "../../../src/engines/reporting/index.js";
import { isModelData, isModelDiff } from "../../../src/engines/reporting/model-render.js";
import { MODEL_BANNER, makeExperimentData, makeModelData, makeResult } from "../../fixtures/reports.js";

const modelResult = (data = makeModelData(), limitations = [makeModelData().limitations[0]!]) =>
  makeResult({ engine: "model", status: "passed", data, limitations });

describe("model guards", () => {
  it("distinguish model data and diffs", () => {
    expect(isModelData(makeModelData())).toBe(true);
    expect(isModelData(makeExperimentData())).toBe(false);
    const diff = diffModels(makeModelData(), makeModelData());
    expect(isModelDiff(diff)).toBe(true);
    expect(isModelData(diff)).toBe(false);
  });
});

describe("model rendering — tty", () => {
  const s = renderReport([modelResult()], "tty", { color: false });

  it("coverage banner first, verbatim", () => {
    const i = s.indexOf("Coverage");
    expect(i).toBeGreaterThan(s.indexOf("[model]"));
    expect(s).toContain(`Coverage\n  ${MODEL_BANNER}`);
    expect(i).toBeLessThan(s.indexOf("Nodes (4)"));
  });

  it("node table: names with aliases, kind, confidence, sources, observed, notes", () => {
    for (const h of ["name", "kind", "confidence", "evidence sources", "observed", "note"])
      expect(s).toContain(h);
    expect(s).toContain("payments-fake (aka PAYMENTS_URL, payments)");
    expect(s).toContain("config, static-heuristic, trace");
    expect(s).toContain("p95 180ms, 12.50/s, err 2.00% [trace]");
    expect(s).toContain("? proposed merge, verify");
    expect(s).toMatch(
      /redis\s+│ cache\s+│\s+50\.00% │ static-heuristic\s+│ -\s+│ low confidence, unconfirmed/,
    );
  });

  it("edge table with evidence and callsPerRequest / p95; low-confidence edge is flagged", () => {
    expect(s).toContain("Edges (2)");
    expect(s).toMatch(
      /shop-express → payments-fake │ calls\s+│\s+96\.00% │ static-heuristic, trace │\s+26\.00 │\s+140ms │/,
    );
    expect(s).toMatch(/shop-express → redis\s+│ reads.*low confidence, unconfirmed/);
  });

  it("merges: rule and proposed vs confirmed", () => {
    expect(s).toContain("Entity merges");
    expect(s).toMatch(
      /payments-fake │ name-similarity │ trace:payments \+ compose:payments-fake │ jw=0\.95 payments~payments-fake │ proposed \(95\.00%\), to verify/,
    );
    expect(s).toMatch(
      /payments-fake │ host-port\s+│ env:PAYMENTS_URL \+ compose:payments\s+│ 127\.0\.0\.1:4010\s+│ confirmed/,
    );
    // proposed merges listed first
    expect(s.indexOf("name-similarity")).toBeLessThan(s.indexOf("host-port"));
  });

  it("critical path per route with dominant dependency and share", () => {
    expect(s).toContain("Critical path");
    expect(s).toMatch(/POST \/orders │ payments-fake\s+│\s+82\.00% │\s+172ms │\s+20 │/);
    expect(s).toContain("Longest critical path: POST /orders (210ms, trace t-1)");
    expect(s).toMatch(/POST \/charges │ payments-fake │ payments-fake\s+│\s+172ms │/);
  });

  it("failure modes, extra model limitations (not duplicated), no mermaid in the terminal", () => {
    expect(s).toContain("Failure modes");
    expect(s).toContain("Retry storm against payments");
    expect(s).toContain("Limitation: Secret values from config are never stored [MODEL_SECRETS_NOT_STORED]");
    expect(s.match(/MODEL_OTLP_PROTOBUF/g)).toHaveLength(1); // only in the result's Limitations section
    expect(s).not.toContain("Mermaid diagram source");
  });

  it("ascii mode uses bannerAscii", () => {
    const a = renderReport([modelResult()], "tty", { color: false, ascii: true });
    expect(a).toContain("Built from: static analysis [x], OpenAPI [x]");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ascii check
    expect(a).toMatch(/^[\u0000-\u007f]*$/);
  });
});

describe("model rendering — md / html / json / junit / sarif", () => {
  it("markdown: banner, tables, mermaid fenced block", () => {
    const md = renderReport([modelResult()], "md");
    expect(md).toContain("**Coverage**\n\n> Built from: static analysis ✓");
    expect(md).toContain("```mermaid\n");
    expect(md).toContain("| POST /orders | payments-fake | 82.00% | 172ms | 20 |");
  });

  it("html: mermaid text in <pre>, escaped, no scripts", () => {
    const html = renderReport([modelResult()], "html");
    expect(html).toMatch(/<pre><code>(graph|flowchart) /);
    expect(html).toContain("--&gt;");
    expect(html).not.toMatch(/<script|\s(src|href)\s*=/i);
    expect(html).toContain('<td class="warn">low confidence, unconfirmed</td>');
  });

  it("json keeps ModelData; junit and sarif have nothing for model data", () => {
    expect(JSON.parse(renderReport([modelResult()], "json")).results[0].data.nodes).toHaveLength(4);
    const xml = renderReport([modelResult()], "junit");
    expect(xml).toContain('tests="0"');
    expect(xml).not.toContain("<testsuite ");
    expect(JSON.parse(renderReport([modelResult()], "sarif")).runs[0].results).toEqual([]);
  });
});

describe("model diff", () => {
  const before = makeModelData();
  const after = makeModelData({
    nodes: [
      ...makeModelData().nodes.filter((n) => n.id !== "datastore:redis"),
      {
        id: "external:stripe",
        kind: "external",
        names: ["stripe"],
        evidence: [{ source: "config", confidence: 0.9, origin: "env", detail: "STRIPE_URL" }],
        confidence: 0.9,
      },
    ],
  });
  after.nodes[0] = {
    ...after.nodes[0]!,
    confidence: 0.7,
    observed: { ...after.nodes[0]!.observed!, p95Ms: 400 },
  };
  const diff = diffModels(before, after);

  it("added / removed / changed tables in every format", () => {
    const s = renderModelDiff(diff, "tty", { color: false });
    expect(s).toContain("Added nodes");
    expect(s).toContain("external:stripe");
    expect(s).toContain("Removed nodes");
    expect(s).toContain("datastore:redis");
    expect(s).toContain("Changed confidence");
    expect(s).toContain("Changed observed metrics");
    expect(s).toMatch(/p95Ms\s+│\s+180\.0 │\s+400\.0 │\s+\+122\.2%/);
    expect(renderModelDiff(diff, "md")).toContain("## SECOND WORLD — system model diff");
    expect(renderModelDiff(diff, "html")).toContain("<h4>Added nodes</h4>");
    expect(JSON.parse(renderModelDiff(diff, "json"))).toEqual(JSON.parse(JSON.stringify(diff)));
  });

  it("unchanged diff says so; diff as EngineResult data renders via the dispatcher", () => {
    const same = diffModels(before, makeModelData());
    expect(renderModelDiff(same, "tty", { color: false })).toContain(
      "No differences above the reporting thresholds.",
    );
    expect(renderReport([makeResult({ engine: "model", data: diff })], "tty", { color: false })).toContain(
      "Added nodes",
    );
  });
});
