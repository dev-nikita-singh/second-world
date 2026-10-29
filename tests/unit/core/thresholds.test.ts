import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  evaluateThreshold,
  formatThreshold,
  parseThreshold,
  parseThresholdEntry,
  parseThresholds,
} from "../../../src/core/config/thresholds.js";
import { ConfigError } from "../../../src/core/errors.js";

describe("parseThreshold", () => {
  it("p(95) < 300ms", () => {
    expect(parseThreshold("p(95) < 300ms")).toMatchObject({
      metric: "http.p95",
      scope: "http",
      stat: "p95",
      percentile: 95,
      op: "<",
      value: 300,
      unit: "ms",
    });
  });
  it("p95<300ms (no spaces) equals p(95) < 300ms", () => {
    const a = parseThreshold("p95<300ms");
    const b = parseThreshold("p(95) < 300ms");
    expect({ ...a, source: "" }).toEqual({ ...b, source: "" });
  });
  it("p(99.9) and p999", () => {
    expect(parseThreshold("p(99.9) <= 1s")).toMatchObject({ stat: "p99.9", percentile: 99.9, op: "<=", value: 1000 });
    expect(parseThreshold("p999 < 2s")).toMatchObject({ stat: "p99.9", percentile: 99.9 });
  });
  it("error_rate < 1%", () => {
    expect(parseThreshold("error_rate < 1%")).toMatchObject({ stat: "error_rate", value: 0.01, unit: "ratio" });
  });
  it("rps > 200", () => {
    expect(parseThreshold("rps > 200")).toMatchObject({ stat: "rps", op: ">", value: 200, unit: "per_s" });
    expect(parseThreshold("rps >= 12000/m")).toMatchObject({ value: 200 });
  });
  it("scoped metrics", () => {
    expect(parseThreshold("scenario.checkout.p99 < 800ms")).toMatchObject({
      metric: "scenario.checkout.p99",
      scope: "scenario.checkout",
    });
    expect(parseThreshold("endpoint.get /api/v1.2/items.p(95) < 1s")).toMatchObject({
      scope: "endpoint.GET /api/v1.2/items",
      stat: "p95",
      value: 1000,
    });
    expect(parseThreshold("http.avg == 10")).toMatchObject({ stat: "avg", op: "==", value: 10 });
  });
  it.each([
    "",
    "p95",
    "p95 < ",
    "< 300ms",
    "p95 ~ 300ms",
    "p(101) < 3ms",
    "foo < 3",
    "error_rate < 150%",
    "p95 < fast",
    "bogus.p95 < 3ms",
    "p95 < 300ms; process.exit()",
    "p(95 < 3ms",
  ])("rejects %j with ConfigError", (s) => {
    expect(() => parseThreshold(s)).toThrow(ConfigError);
  });
  it("property: arbitrary strings throw only ConfigError", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        try {
          parseThreshold(s);
        } catch (e) {
          expect(e).toBeInstanceOf(ConfigError);
        }
      }),
    );
  });
  it("property: format/parse round-trip for generated thresholds", () => {
    const stat = fc.oneof(
      fc.integer({ min: 1, max: 99 }).map((p) => `p(${p})`),
      fc.constantFrom("avg", "max", "error_rate", "rps"),
    );
    const op = fc.constantFrom("<", "<=", ">", ">=", "==");
    fc.assert(
      fc.property(stat, op, fc.integer({ min: 0, max: 100 }), fc.constantFrom("", " "), (s, o, n, ws) => {
        const value = s === "error_rate" ? `${n}%` : s === "rps" ? `${n}/s` : `${n}ms`;
        const t = parseThreshold(`${s}${ws}${o}${ws}${value}`);
        const again = parseThreshold(formatThreshold(t));
        expect(again.metric).toBe(t.metric);
        expect(again.op).toBe(t.op);
        expect(again.value).toBeCloseTo(t.value, 12);
      }),
    );
  });
});

describe("parseThresholdEntry / parseThresholds", () => {
  it("metric-keyed operator form", () => {
    expect(parseThresholdEntry("http.p95", "< 300ms")).toMatchObject({
      metric: "http.p95",
      op: "<",
      value: 300,
      abortOnFail: false,
    });
    expect(parseThresholdEntry("http.error_rate", "< 1%")).toMatchObject({ value: 0.01 });
  });
  it("object form with abortOnFail and delayAbortEval", () => {
    expect(
      parseThresholdEntry("scenario.checkout.p99", { expr: "< 800ms", abortOnFail: true, delayAbortEval: "30s" }),
    ).toMatchObject({ metric: "scenario.checkout.p99", value: 800, abortOnFail: true, delayAbortEvalMs: 30_000 });
  });
  it("k6-style: key is a scope, value a full expression", () => {
    expect(parseThresholdEntry("http", "p(95) < 300ms")).toMatchObject({ metric: "http.p95" });
    expect(parseThresholdEntry("scenario.browse", "p99 < 1s")).toMatchObject({ metric: "scenario.browse.p99" });
  });
  it("parseThresholds handles arrays and reports key path", () => {
    const list = parseThresholds({ http: ["p95 < 300ms", "p99 < 1s"], "http.error_rate": "< 1%" });
    expect(list).toHaveLength(3);
    expect(() => parseThresholds({ "http.p95": "< banana" })).toThrow(/thresholds\.http\.p95/);
  });
});

describe("evaluateThreshold", () => {
  it("operators", () => {
    expect(evaluateThreshold(parseThreshold("p95 < 300ms"), 299)).toBe(true);
    expect(evaluateThreshold(parseThreshold("p95 < 300ms"), 300)).toBe(false);
    expect(evaluateThreshold(parseThreshold("p95 <= 300ms"), 300)).toBe(true);
    expect(evaluateThreshold(parseThreshold("rps > 200"), 200)).toBe(false);
    expect(evaluateThreshold(parseThreshold("rps >= 200"), 200)).toBe(true);
    expect(evaluateThreshold(parseThreshold("error_rate == 0"), 0)).toBe(true);
    expect(evaluateThreshold(parseThreshold("error_rate < 1%"), 0.1 + 0.2 - 0.3)).toBe(true);
  });
  it("NaN never passes", () => {
    expect(evaluateThreshold({ op: ">", value: 0 }, Number.NaN)).toBe(false);
  });
});
