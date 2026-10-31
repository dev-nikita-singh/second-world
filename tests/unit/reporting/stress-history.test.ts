import { describe, expect, it } from "vitest";
import { isRunComparison, isStressData } from "../../../src/engines/reporting/blocks.js";
import { htmlEscape } from "../../../src/engines/reporting/html.js";
import { renderComparison, renderReport } from "../../../src/engines/reporting/index.js";
import { mdEscape } from "../../../src/engines/reporting/markdown.js";
import {
  CAPACITY_STATEMENT,
  makeComparison,
  makePerfData,
  makeResult,
  makeStressData,
} from "../../fixtures/reports.js";

const stressResult = (over = {}) =>
  makeResult({ engine: "stress", status: "failed", data: makeStressData(over) });

describe("guards", () => {
  it("distinguish stress, comparison and perf payloads", () => {
    expect(isStressData(makeStressData())).toBe(true);
    expect(isStressData(makePerfData())).toBe(false);
    expect(isRunComparison(makeComparison())).toBe(true);
    expect(isRunComparison(makeStressData())).toBe(false);
    expect(isStressData(null)).toBe(false);
  });
});

describe("StressData rendering", () => {
  const tty = renderReport([stressResult()], "tty", { color: false });

  it("stage table has the required columns and rows", () => {
    for (const col of [
      "level",
      "status",
      "throughput",
      "p50",
      "p95",
      "p99",
      "error rate",
      "breach reasons",
      "invalid",
    ]) {
      expect(tty).toContain(col);
    }
    expect(tty).toContain("│ 200/s │");
    expect(tty).toContain("breached");
    expect(tty).toContain("http.p95 < 300ms");
    expect(tty).toContain("INVALID");
    expect(tty).toContain("2.00%");
  });

  it("capacity statement verbatim in its own Capacity block; 'tested capacity' wording", () => {
    expect(tty).toContain(`Capacity\n  ${CAPACITY_STATEMENT}`);
    expect(tty).toContain("tested capacity");
    expect(tty).not.toMatch(/max(imum)? capacity/i);
  });

  it("first breach, knee, invalid-from warning, sparkline", () => {
    expect(tty).toContain("first breach");
    expect(tty).toContain("stage 3 at 400/s: http.p95 < 300ms (actual 340.0)");
    expect(tty).toContain("knee");
    expect(tty).toContain("stage 2 at 200/s");
    expect(tty).toContain("saturated from stage 4");
    expect(tty).toMatch(/p95 by load level [▁▂▃▄▅▆▇█]{4}/);
  });

  it("USL is in a separate, clearly labelled Estimates section after the measured results", () => {
    const i = tty.indexOf("Estimates (model fit, not measured)");
    expect(i).toBeGreaterThan(tty.indexOf("Stages"));
    expect(i).toBeGreaterThan(tty.indexOf(CAPACITY_STATEMENT));
    const est = tty.slice(i);
    expect(est).toContain("Universal Scalability Law");
    expect(est).toContain("σ (contention)");
    expect(est).toContain("0.0500");
    expect(est).toContain("estimated peak N*");
    expect(est).toContain("97.50");
    expect(est).toContain("extrapolated");
  });

  it("refused USL is shown as refused; absent USL has no Estimates section", () => {
    const refused = renderReport(
      [
        stressResult({
          usl: {
            kind: "estimate",
            lambda: null,
            sigma: null,
            kappa: null,
            r2: null,
            peakN: null,
            peakThroughput: null,
            basis: "vus",
            points: 2,
            refused: "fewer than 4 valid stages",
          },
        }),
      ],
      "tty",
      { color: false },
    );
    expect(refused).toContain("USL estimate refused: fewer than 4 valid stages");
    const none = renderReport([stressResult({ usl: undefined })], "tty", { color: false });
    expect(none).not.toContain("Estimates");
  });

  it("breakpoint, spike recovery and soak drift", () => {
    const s = renderReport(
      [
        stressResult({
          mode: "breakpoint",
          breakpoint: { lastPass: 250, firstFail: 275, minStep: 25, bisectionStages: 3, converged: true },
          spike: { baselineP95: 20, peakP95: 900, recoveryTimeS: 4.5, recovered: true, toleranceMs: 10 },
          soak: {
            windowMs: 10_000,
            points: 30,
            p95SlopeMsPerHour: 12.5,
            ci95: [8, 17],
            drift: true,
            changePoints: [{ t: 120, direction: "up" }],
          },
        }),
      ],
      "tty",
      { color: false },
    );
    expect(s).toContain(
      "last pass 250/s, first fail 275/s, converged (min step 25.00), 3 bisection stage(s)",
    );
    expect(s).toContain("4.50 s back to baseline p95");
    expect(s).toContain("drift detected: p95 +12.50 ms/h");
    expect(s).toContain("[8.00, 17.00] ms/h");
    expect(s).toContain("120.0s up");
    const notRecovered = renderReport(
      [
        stressResult({
          spike: { baselineP95: 20, peakP95: 900, recoveryTimeS: null, recovered: false, toleranceMs: 10 },
        }),
      ],
      "tty",
      { color: false },
    );
    expect(notRecovered).toContain("not recovered");
  });

  it("vus load type renders levels as VUs; ascii mode is pure ASCII", () => {
    const s = renderReport([stressResult({ loadType: "vus" })], "tty", { color: false, ascii: true });
    expect(s).toContain("200 VUs");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ascii check
    expect(s).toMatch(/^[\u0000-\u007f]*$/);
    expect(s).toContain("sigma (contention)");
  });

  it("markdown and html carry the same content", () => {
    const md = renderReport([stressResult()], "md");
    expect(md).toContain(`**Capacity**\n\n> ${mdEscape(CAPACITY_STATEMENT)}`);
    expect(md).toContain(
      "| # | level | status | throughput | p50 | p95 | p99 | error rate | breach reasons | invalid |",
    );
    expect(md).toContain("#### Estimates (model fit, not measured)");
    expect(md).toContain("- **usl**: nonlinear least squares");
    const html = renderReport([stressResult()], "html");
    expect(html).toContain(`<blockquote class="statement">${htmlEscape(CAPACITY_STATEMENT)}</blockquote>`);
    expect(html).toMatch(/<section class="estimate">\s*<h4>Estimates \(model fit, not measured\)<\/h4>/);
    expect(html).toContain('<svg class="spark"');
  });
});

describe("history comparison rendering", () => {
  it("single-run shows movement + 'no statistics'; statistical shows verdict, ci95, pAdjusted", () => {
    const s = renderComparison(makeComparison(), "tty", { color: false });
    expect(s).toContain("worse (no statistics)");
    expect(s).toContain("+30.0%");
    expect(s).toContain("regressed");
    expect(s).toContain("[-30.00, -10.00]");
    expect(s).toContain("0.00800");
    expect(s).toContain("no statistics. Movement beyond the change threshold is shown, not significance.");
    // a single-run row must not show a ci95 or p value
    const row = s.split("\n").find((l) => l.includes("performance.http.p95")) ?? "";
    expect(row).not.toMatch(/\[|0\.0\d/);
  });

  it("finding changes: new, fixed, regressed, unchanged", () => {
    const s = renderComparison(makeComparison(), "tty", { color: false });
    expect(s).toMatch(/findings new\s+1/);
    expect(s).toMatch(/findings fixed\s+1/);
    expect(s).toMatch(/findings regressed\s+1/);
    expect(s).toMatch(/findings unchanged\s+1/);
    for (const t of ["BOLA on orders", "N+1 on products", "Stock race", "Schema drift"])
      expect(s).toContain(t);
    expect(s.indexOf("BOLA on orders")).toBeLessThan(s.indexOf("Schema drift")); // new before unchanged
    expect(s).toContain("Regressions: performance.http.rps regressed (-10%)");
  });

  it("json / md / html formats and via an EngineResult in a combined report", () => {
    const cmp = makeComparison();
    expect(JSON.parse(renderComparison(cmp, "json"))).toEqual(cmp);
    const md = renderComparison(cmp, "md");
    expect(md).toContain(
      "| performance.http.p95 | single-run | 100.0 | 130.0 | +30.0% | worse (no statistics) | - | - |",
    );
    expect(md).toContain(
      "| performance.http.rps | statistical | 200.0 | 180.0 | -10.0% | regressed | \\[-30.00, -10.00\\] | 0.00800 |",
    );
    const html = renderComparison(cmp, "html");
    expect(html).toContain("worse (no statistics)");
    expect(html).not.toMatch(/<script/i);
    const inReport = renderReport([makeResult({ engine: "history", data: cmp })], "tty", { color: false });
    expect(inReport).toContain("worse (no statistics)");
  });
});
