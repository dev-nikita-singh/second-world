/**
 * Property tests for unit parsing/formatting (docs/08-configuration.md §2) and threshold
 * parse → format → parse round-trips and evaluation monotonicity (docs/08 §4).
 * Owner: sw-coverage (Wave 5).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import {
  evaluateThreshold,
  formatThreshold,
  parseThreshold,
  parseThresholdEntry,
  parseThresholds,
} from "../../../src/core/config/thresholds.js";
import { formatBytes, formatDuration, parseBytes, parseDuration, parsePercent, parseRate } from "../../../src/core/config/units.js";

describe("durations", () => {
  it("property: formatDuration → parseDuration round-trips (≤ 0.5 s or 1% error)", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 7 * 86_400_000, noNaN: true }), (ms) => {
        const back = parseDuration(formatDuration(ms));
        expect(Math.abs(back - ms)).toBeLessThanOrEqual(Math.max(500, ms * 0.01));
      }),
      { numRuns: 500 },
    );
  });

  it("property: compound durations add up their components", () => {
    fc.assert(
      fc.property(fc.nat(99), fc.nat(59), fc.nat(59), fc.nat(999), (h, m, s, msPart) => {
        expect(parseDuration(`${h}h${m}m ${s}s ${msPart}ms`)).toBe(h * 3_600_000 + m * 60_000 + s * 1000 + msPart);
      }),
    );
  });

  it("rejects malformed, negative, non-finite, unordered and repeated components", () => {
    for (const bad of ["", " ", "1x", "30m1h", "1s1s", "h", "1h30", "-5ms", "1..5s", ".s", "1e3ms", "NaN"]) {
      expect(() => parseDuration(bad), JSON.stringify(bad)).toThrow(ConfigError);
    }
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => parseDuration(bad, "x.y")).toThrow(/x\.y: Invalid duration/);
    expect(() => parseDuration({} as unknown as string)).toThrow(ConfigError);
    expect(parseDuration("250")).toBe(250);
    expect(parseDuration(" 1.5s ")).toBe(1500);
    expect(parseDuration("500µs")).toBe(0.5);
    expect(parseDuration("2us")).toBe(0.002);
    expect(parseDuration("1D")).toBe(86_400_000);
  });

  it("formatDuration edge cases", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(-1500)).toBe("-1.5s");
    expect(formatDuration(0.25)).toBe("250µs");
    expect(formatDuration(5_400_000)).toBe("1h30m");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(Number.NaN)).toBe("NaN");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });
});

describe("bytes, rates, percentages", () => {
  it("property: parseBytes scales are monotone and binary ≥ decimal", () => {
    fc.assert(
      fc.property(fc.nat(10_000), (n) => {
        const kb = parseBytes(`${n}KB`);
        const kib = parseBytes(`${n} KiB`);
        expect(kib).toBeGreaterThanOrEqual(kb);
        expect(parseBytes(`${n}MB`)).toBeGreaterThanOrEqual(kb);
        expect(parseBytes(`${n}`)).toBe(n);
      }),
    );
  });

  it("parseBytes rejects junk; formatBytes picks the largest binary unit", () => {
    for (const bad of ["", "KB", "10 XB", "10KB extra", "-1KB"]) expect(() => parseBytes(bad), bad).toThrow(ConfigError);
    for (const bad of [-1, Number.NaN]) expect(() => parseBytes(bad)).toThrow(ConfigError);
    expect(() => parseBytes(null as unknown as string)).toThrow(ConfigError);
    expect(parseBytes(12)).toBe(12);
    expect(parseBytes("1.5k")).toBe(1500);
    expect(parseBytes("1 tib")).toBe(1024 ** 4);
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 ** 5)).toBe("1024 TiB");
    expect(formatBytes(-2048)).toBe("-2 KiB");
    expect(formatBytes(Number.NaN)).toBe("NaN");
  });

  it("property: rates in different units are consistent", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (n) => {
        expect(parseRate(`${n}/m`)).toBeCloseTo(parseRate(`${n}/s`) / 60, 6);
        expect(parseRate(`${n} / hour`)).toBeCloseTo(n / 3600, 6);
        expect(parseRate(`${n}rps`)).toBe(n);
        expect(parseRate(`${n}`)).toBe(n);
      }),
    );
    expect(parseRate("5/ms")).toBe(5000);
    for (const bad of ["", "/s", "5/", "5/fortnight", "5 per s", "5/s/s"]) expect(() => parseRate(bad), bad).toThrow(ConfigError);
    for (const bad of [-1, Number.POSITIVE_INFINITY]) expect(() => parseRate(bad)).toThrow(ConfigError);
    expect(() => parseRate(true as unknown as string)).toThrow(ConfigError);
  });

  it("parsePercent: % and fractions, bounds enforced", () => {
    expect(parsePercent("1%")).toBe(0.01);
    expect(parsePercent("0.5 %")).toBe(0.005);
    expect(parsePercent("0.25")).toBe(0.25);
    expect(parsePercent(1)).toBe(1);
    for (const bad of ["150%", "2", "%", "1%%", "1% x", -0.1, 1.01, Number.NaN]) expect(() => parsePercent(bad as string), String(bad)).toThrow(ConfigError);
    expect(() => parsePercent(undefined as unknown as string)).toThrow(ConfigError);
  });
});

describe("thresholds", () => {
  const ops = ["<", "<=", ">", ">=", "=="] as const;

  it("property: parse → format → parse is stable for latency, ratio, rate and count thresholds", () => {
    const stat = fc.constantFrom("p(95)", "p(99.9)", "avg", "max", "med", "error_rate", "rps", "requests", "errors");
    fc.assert(
      fc.property(stat, fc.constantFrom(...ops), fc.integer({ min: 0, max: 100_000 }), (s, op, n) => {
        const unit = s.startsWith("p(") || ["avg", "max", "med"].includes(s) ? "ms" : s === "error_rate" ? "%" : s === "rps" ? "/s" : "";
        const value = unit === "%" ? `${n % 101}%` : `${n}${unit}`;
        const t1 = parseThreshold(`http.${s} ${op} ${value}`);
        const t2 = parseThreshold(formatThreshold(t1));
        expect({ ...t2, source: "" }).toEqual({ ...t1, source: "" });
      }),
    );
  });

  it("property: evaluation is monotone in the observed value", () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.double({ min: 0, max: 1e6, noNaN: true }), (v, x, d) => {
        // lower values pass "<"/"<=" at least as often; higher pass ">"/">=" at least as often
        for (const op of ["<", "<="] as const) if (evaluateThreshold({ op, value: v }, x + d)) expect(evaluateThreshold({ op, value: v }, x)).toBe(true);
        for (const op of [">", ">="] as const) if (evaluateThreshold({ op, value: v }, x)) expect(evaluateThreshold({ op, value: v }, x + d)).toBe(true);
      }),
    );
    for (const op of ops) expect(evaluateThreshold({ op, value: 1 }, Number.NaN)).toBe(false);
    expect(evaluateThreshold({ op: "==", value: 0.3 }, 0.1 + 0.2)).toBe(true);
    expect(evaluateThreshold({ op: "<=", value: 0.3 }, 0.1 + 0.2)).toBe(true);
  });

  it("entry forms: operator-only, k6-style scope key, object form with abort + delay, arrays", () => {
    expect(parseThresholdEntry("http.p95", "< 300ms")).toMatchObject({ stat: "p95", percentile: 95, value: 300, abortOnFail: false });
    expect(parseThresholdEntry("scenario.checkout", "p(99) < 1s")).toMatchObject({ scope: "scenario.checkout", metric: "scenario.checkout.p99" });
    expect(parseThresholdEntry("http", { expr: "error_rate < 1%", abortOnFail: true, delayAbortEval: "10s" })).toMatchObject({
      abortOnFail: true,
      delayAbortEvalMs: 10_000,
      value: 0.01,
    });
    expect(parseThresholds({ http: ["p(95) < 300ms", "rps > 10"] })).toHaveLength(2);
    expect(parseThresholds(undefined)).toEqual([]);
  });

  it("errors carry the key path and never crash on odd input", () => {
    expect(() => parseThresholds({ "http.p95": "300ms" })).toThrow(/thresholds\.http\.p95: .*missing operator/);
    expect(() => parseThresholdEntry("http", { nope: 1 } as unknown as string)).toThrow(/expected a string/);
    expect(() => parseThreshold(5 as unknown as string)).toThrow(ConfigError);
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        try {
          parseThreshold(s);
        } catch (e) {
          expect(e).toBeInstanceOf(ConfigError);
        }
      }),
      { numRuns: 500 },
    );
  });
});
