import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { isEvolutionData, isExperimentData } from "../../../src/engines/reporting/experiments.js";
import { renderReport } from "../../../src/engines/reporting/index.js";
import {
  makeAAData,
  makeEvolutionData,
  makeExperimentData,
  makeFinding,
  makePerfData,
  makeResult,
} from "../../fixtures/reports.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

// ---------------------------------------------------------------- hypotheses in SARIF

describe("hypothesis findings", () => {
  it("sarif: hypotheses are notes marked as unverified", () => {
    const r = makeResult({
      engine: "model",
      status: "passed",
      findings: [
        makeFinding({
          id: "m-1",
          engine: "model",
          ruleId: "model/hypothesis",
          severity: "critical",
          classification: "hypothesis",
          title: "possible hidden dependency",
        }),
      ],
    });
    const sarif = JSON.parse(renderReport([r], "sarif"));
    const res = sarif.runs[0].results as Array<{
      level: string;
      message: { text: string };
      properties: Record<string, unknown>;
    }>;
    expect(res).toHaveLength(1);
    expect(res[0]!.level).toBe("note");
    expect(res[0]!.message.text.startsWith("[hypothesis] ")).toBe(true);
    expect(res[0]!.properties).toMatchObject({ hypothesis: true, verified: false });
    expect(res[0]!.properties.aiGenerated).toBeUndefined();
  });
});

// ---------------------------------------------------------------- What-If

const exp = () => makeResult({ engine: "whatif", status: "passed", data: makeExperimentData() });

describe("What-If rendering", () => {
  it("guards", () => {
    expect(isExperimentData(makeExperimentData())).toBe(true);
    expect(isEvolutionData(makeExperimentData())).toBe(false);
    expect(isEvolutionData(makeEvolutionData())).toBe(true);
  });

  it("tty: verdict table per metric with medians, change, CI, Holm p, Cliff's δ, verdict, success, runs needed", () => {
    const s = renderReport([exp()], "tty", { color: false });
    for (const h of [
      "variant",
      "metric",
      "baseline → variant (median)",
      "change",
      "CI",
      "p (Holm)",
      "Cliff's δ",
      "verdict",
      "success",
      "runs needed",
    ]) {
      expect(s).toContain(h);
    }
    expect(s).toContain("95.0ms → 55.1ms");
    expect(s).toContain("-42.0%");
    expect(s).toContain("[-50.0%, -35.0%]");
    expect(s).toContain("0.0317");
    expect(s).toContain("-1.00 (large)");
    expect(s).toContain("met (p95 improvement >= 15%)");
    expect(s).toContain("inconclusive (error_rate not worse)");
    expect(s).toContain("12/arm");
    expect(s).toContain("95% BCA bootstrap CI");
  });

  it("tty: hypothesis per variant, flagged runs, environment warnings, estimates section", () => {
    const s = renderReport([exp()], "tty", { color: false });
    expect(s).toMatch(/hypothesis\s+Indexed search lowers p95 by >= 15%/);
    expect(s).toContain("Hypothesis per variant");
    expect(s).toMatch(/fixed\s+│ inconclusive │ p95/);
    expect(s).toContain("outlier (MAD z > 3.5): p95");
    expect(s).toContain("start failed: EADDRINUSE");
    expect(s).toContain("environment fingerprints differ between arms");
    expect(s).toContain("arm fixed ran on a different Node version");
    const i = s.indexOf("Estimates (model, not measured)");
    expect(i).toBeGreaterThan(s.indexOf("Verdicts per metric"));
    expect(s.slice(i)).toContain("M/M/1 queueing projection");
    expect(s.slice(i)).toContain("Assumptions: Poisson arrivals, single server");
    expect(s.slice(i)).toContain("extrapolated");
  });

  it("A/A: noise floor table, no hypothesis table", () => {
    const s = renderReport([makeResult({ engine: "whatif", data: makeAAData() })], "tty", { color: false });
    expect(s).toContain("A/A (baseline vs itself: noise floor)");
    expect(s).toContain("Noise floor (A/A): smallest detectable effect at this r");
    expect(s).toMatch(/p95\s+│\s+3\.10% │\s+1\.20% │\s+4 │/);
    expect(s).not.toContain("Hypothesis per variant");
  });

  it("md / html / json", () => {
    const md = renderReport([exp()], "md");
    expect(md).toContain(
      "| fixed | p95 | 95.0ms → 55.1ms | -42.0% | \\[-50.0%, -35.0%\\] | 0.0317 | -1.00 (large) | improved | met (p95 improvement &gt;= 15%) |  |",
    );
    expect(md).toContain("#### Estimates (model, not measured)");
    const html = renderReport([exp()], "html");
    expect(html).toContain('<section class="estimate">');
    expect(html).toContain("95.0ms → 55.1ms");
    expect(html).not.toMatch(/<script|\s(src|href)\s*=/i);
    expect(JSON.parse(renderReport([exp()], "json")).results[0].data.comparisons).toHaveLength(2);
  });

  it("junit: one case per variant × success criterion; A/A one per metric", () => {
    const xml = renderReport([exp()], "junit");
    const names = [...xml.matchAll(/<testcase name="([^"]+)" classname="([^"]+)"/g)].map(
      (m) => `${m[2]}::${m[1]}`,
    );
    expect(names).toEqual([
      "whatif.fixed::fixed: p95 improvement &gt;= 15%",
      "whatif.fixed::fixed: error_rate not worse",
    ]);
    expect(xml).toContain(
      '<skipped message="inconclusive: CI includes a 12% worsening (≈12 runs/arm needed)"/>',
    );
    const notMet = makeExperimentData();
    notMet.comparisons[0]!.success = {
      criterion: "p95 improvement >= 15%",
      status: "not-met",
      detail: "only -3%",
    };
    expect(renderReport([makeResult({ engine: "whatif", data: notMet })], "junit")).toContain(
      '<failure message="only -3%" type="success-criterion-not-met">',
    );
    const aa = renderReport([makeResult({ engine: "whatif", data: makeAAData() })], "junit");
    expect(aa).toContain('<testcase name="A/A: p95" classname="whatif.aa">');
    expect(aa).toContain('failures="0"');
  });
});

// ---------------------------------------------------------------- Evolution

const evo = () => makeResult({ engine: "evolution", status: "passed", data: makeEvolutionData() });

describe("Evolution rendering", () => {
  it("tty: Pareto front, candidates, gates, rejected, working tree, sandbox, embedded experiment", () => {
    const s = renderReport([evo()], "tty", { color: false });
    expect(s).toContain("Pareto front (best first)");
    expect(s).toContain("1. fix/index");
    expect(s).toMatch(/sandbox\s+docker, node:24-slim, 1 cpu, 1g, network none/);
    expect(s).toMatch(/working tree\s+unchanged \(checksum verified\)/);
    expect(s).toMatch(/baseline\s+HEAD @ 0123456789/);
    for (const h of ["rank", "ref", "status", "diff", "Δ p95", "Δ rps", "verdicts", "score"])
      expect(s).toContain(h);
    expect(s).toContain("branch:fix/index ★");
    expect(s).toContain("+42.0%");
    expect(s).toContain("p95: improved, rps: no-significant-change");
    expect(s).toContain("0.310");
    expect(s).toContain("Gates");
    expect(s).toMatch(/cache\.diff\s+│ test\s+│ npm test\s+│ FAIL/);
    expect(s).toMatch(/replay\s+│ replay\s+│ skipped/);
    expect(s).toContain("Rejected");
    expect(s).toContain("test gate failed: 2 tests failed");
    expect(s).toContain("Benchmark (What-If: baseline vs accepted candidates)");
    expect(s).toContain("Verdicts per metric");
  });

  it("changed working tree is loud; empty front explained", () => {
    const s = renderReport(
      [
        makeResult({
          engine: "evolution",
          data: makeEvolutionData({
            workingTree: { before: "a", after: "b", unchanged: false },
            paretoFront: [],
          }),
        }),
      ],
      "tty",
      { color: false },
    );
    expect(s).toContain("CHANGED during the run");
    expect(s).toContain("none: no candidate passed the gates");
  });

  it("md / html / json", () => {
    const md = renderReport([evo()], "md");
    expect(md).toContain("**Pareto front (best first)**\n\n> 1. fix/index");
    expect(md).toContain("| cache.diff | test | npm test | FAIL | 4.2s | 2 tests failed |");
    expect(md).toContain("- **ranking**: Pareto front, then weighted score");
    const html = renderReport([evo()], "html");
    expect(html).toContain("<h4>Gates</h4>");
    expect(html).not.toMatch(/<script|\s(src|href)\s*=/i);
    expect(JSON.parse(renderReport([evo()], "json")).results[0].data.paretoFront).toEqual(["fix/index"]);
  });

  it("junit: one case per candidate gate (+ embedded experiment criteria)", () => {
    const xml = renderReport([evo()], "junit");
    const gateCases = [...xml.matchAll(/<testcase name="([^"]+)" classname="evolution\.([^"]+)"/g)].map(
      (m) => `${m[2]}::${m[1]}`,
    );
    expect(gateCases).toEqual([
      "fix/index::fix/index: worktree",
      "fix/index::fix/index: install",
      "fix/index::fix/index: test (npm test)",
      "fix/index::fix/index: replay",
      "fix/index::fix/index: benchmark",
      "cache.diff::cache.diff: worktree",
      "cache.diff::cache.diff: install",
      "cache.diff::cache.diff: test (npm test)",
      "cache.diff::cache.diff: replay",
    ]);
    expect(xml).toContain(
      '<failure message="test gate failed" type="gate-test">2 tests failed\ntest gate failed: 2 tests failed</failure>',
    );
    expect(xml).toContain('<skipped message="no artifacts"/>');
    expect(xml).toContain('classname="whatif.fixed"');
  });
});
