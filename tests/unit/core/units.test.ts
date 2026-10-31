import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  formatDuration,
  parseBytes,
  parseDuration,
  parsePercent,
  parseRate,
} from "../../../src/core/config/units.js";
import { ConfigError } from "../../../src/core/errors.js";

describe("parseDuration", () => {
  it.each([
    ["250ms", 250],
    ["30s", 30_000],
    ["5m", 300_000],
    ["1h30m", 5_400_000],
    ["1.5s", 1500],
    ["1m30s", 90_000],
    ["1s500ms", 1500],
    ["100", 100],
    [" 2s ", 2000],
    ["500us", 0.5],
  ])("%s -> %d", (s, ms) => expect(parseDuration(s)).toBe(ms));
  it("numbers are ms", () => expect(parseDuration(42)).toBe(42));
  it.each(["", "abc", "5x", "30m1h", "-5s", "1h1h", "s", "5 s s", "1e3s"])("rejects %j", (s) => {
    expect(() => parseDuration(s)).toThrow(ConfigError);
  });
  it("rejects negative / non-finite numbers", () => {
    expect(() => parseDuration(-1)).toThrow(ConfigError);
    expect(() => parseDuration(Number.NaN)).toThrow(ConfigError);
  });
  it("includes key path in errors", () => {
    expect(() => parseDuration("bad", "performance.duration")).toThrow(/performance\.duration/);
  });
  it("property: n<unit> parses to n*scale", () => {
    const units: Array<[string, number]> = [
      ["ms", 1],
      ["s", 1000],
      ["m", 60_000],
      ["h", 3_600_000],
    ];
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.constantFrom(...units), (n, [u, k]) => {
        expect(parseDuration(`${n}${u}`)).toBe(n * k);
      }),
    );
  });
  it("property: formatDuration round-trips whole seconds/ms", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 1, max: 999 }),
          fc.integer({ min: 1, max: 500_000 }).map((s) => s * 1000),
        ),
        (ms) => {
          expect(parseDuration(formatDuration(ms))).toBe(ms);
        },
      ),
    );
  });
  it("property: never throws non-ConfigError on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        try {
          const v = parseDuration(s);
          expect(Number.isFinite(v) && v >= 0).toBe(true);
        } catch (e) {
          expect(e).toBeInstanceOf(ConfigError);
        }
      }),
    );
  });
});

describe("parseBytes", () => {
  it.each([
    ["512B", 512],
    ["10KB", 10_000],
    ["5MiB", 5 * 1024 * 1024],
    ["1.5KiB", 1536],
    ["2gb", 2e9],
    ["100", 100],
  ])("%s -> %d", (s, b) => expect(parseBytes(s)).toBe(b));
  it.each(["", "10XB", "KB", "10 KB B"])("rejects %j", (s) =>
    expect(() => parseBytes(s)).toThrow(ConfigError),
  );
});

describe("parseRate", () => {
  it.each([
    ["200/s", 200],
    ["12000/m", 200],
    ["3600/h", 1],
    ["5/ms", 5000],
    ["150", 150],
    ["100 rps", 100],
    ["60 / min", 1],
  ])("%s -> %d", (s, r) => expect(parseRate(s)).toBeCloseTo(r, 9));
  it.each(["", "/s", "10/x", "fast"])("rejects %j", (s) => expect(() => parseRate(s)).toThrow(ConfigError));
});

describe("parsePercent", () => {
  it.each([
    ["1%", 0.01],
    ["0.5%", 0.005],
    [0.01, 0.01],
    ["0.01", 0.01],
    ["100%", 1],
  ] as Array<[string | number, number]>)("%s -> %d", (s, r) => expect(parsePercent(s)).toBeCloseTo(r, 12));
  it.each(["150%", 2, -0.1, "abc", "1%%"] as Array<string | number>)("rejects %j", (s) =>
    expect(() => parsePercent(s)).toThrow(ConfigError),
  );
  it("property: x% = x/100", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (x) => {
        expect(parsePercent(`${x}%`)).toBeCloseTo(x / 100, 12);
      }),
    );
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [0.25, "250µs"],
    [250, "250ms"],
    [1500, "1.5s"],
    [5_400_000, "1h30m"],
    [90_000, "1m30s"],
  ])("%d -> %s", (ms, s) => expect(formatDuration(ms)).toBe(s));
});
