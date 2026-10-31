/**
 * Error taxonomy of config loading (docs/02-architecture.md §4.5, docs/08-configuration.md,
 * docs/16-system-design.md §3). Every user mistake in config must surface as a ConfigError
 * (exit 2) with the key path and an actionable message — never as a plain Error (exit 70).
 *
 * Gaps reproduced here before the fix (src/core/config/**):
 *  - unknown keys were reported on the parent only ("safety: Unknown key(s): maxRPS"), with no
 *    full path and no suggestion for an obvious typo;
 *  - a non-mapping `thresholds` value (string/array) produced "thresholds.0: Invalid threshold \"p\"";
 *  - `abortOnFail: "yes"` was accepted and passed through as a string;
 *  - a bad `delayAbortEval` repeated the path twice;
 *  - NaN/Infinity durations were printed as `null`.
 */
import { describe, expect, it } from "vitest";
import { loadConfig, parseSetArgs } from "../../../src/core/config/loader.js";
import { parseThresholds } from "../../../src/core/config/thresholds.js";
import { parseDuration } from "../../../src/core/config/units.js";
import { ConfigError, ExitCode } from "../../../src/core/errors.js";

async function configError(
  inline: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
): Promise<ConfigError> {
  try {
    await loadConfig({ inline, userConfig: false, env });
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error("expected loadConfig to fail");
}

function thrown(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

describe("config errors map to exit 2 with the key path", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["bad unit value", { safety: { maxDuration: "10 parsecs" } }, /safety\.maxDuration: Invalid duration/],
    ["wrong type", { safety: { maxConcurrency: "many" } }, /safety\.maxConcurrency: /],
    ["bad url", { targets: { api: { url: "ftp://x" } } }, /targets\.api\.url: Invalid URL/],
    ["null section", { safety: null }, /safety: /],
    ["array where mapping expected", { targets: [] }, /targets: /],
    [
      "empty workflow engine",
      { workflows: { w: { steps: { a: { engine: "" } } } } },
      /workflows\.w\.steps\.a\.engine/,
    ],
  ];
  for (const [name, inline, re] of cases) {
    it(name, async () => {
      const e = await configError(inline);
      expect(e.exitCode).toBe(ExitCode.ConfigInvalid);
      expect(e.code).toBe("SW_CONFIG_INVALID");
      expect(e.message).toMatch(re);
      expect(e.hint).toBeTruthy();
    });
  }

  it("env overlay errors name the env var", async () => {
    const e = await configError({}, { SW_SAFETY__MAX_RPS: "abc" });
    expect(e.message).toMatch(/safety\.maxRps: .*← from env SW_SAFETY__MAX_RPS/);
  });
});

describe("unknown keys", () => {
  it("are reported with their full path, one line each", async () => {
    const e = await configError({ safety: { maxRPS: 10, bogus: 1 } });
    expect(e.message).toMatch(/^ {2}safety\.maxRPS: Unknown key/m);
    expect(e.message).toMatch(/^ {2}safety\.bogus: Unknown key/m);
  });

  it("suggest the closest known key for a typo", async () => {
    expect((await configError({ safety: { maxRPS: 10 } })).message).toContain('did you mean "maxRps"?');
    expect((await configError({ perfomance: {} })).message).toContain('did you mean "performance"?');
    expect((await configError({ safety: { redact: { headerz: [] } } })).message).toContain(
      'safety.redact.headerz: Unknown key (did you mean "headers"?)',
    );
  });

  it("do not suggest anything for an unrelated name", async () => {
    const e = await configError({ safety: { zzzzzzzz: 1 } });
    expect(e.message).toMatch(/safety\.zzzzzzzz: Unknown key {3}← from inline$/m);
    expect(e.message).not.toContain("did you mean");
  });

  it("issue details carry the full path", async () => {
    const e = await configError({ report: { formatz: [] } });
    const issues = (e.details?.issues ?? []) as Array<{ path: string }>;
    expect(issues.map((i) => i.path)).toContain("report.formatz");
  });
});

describe("thresholds", () => {
  it("a non-mapping thresholds value is rejected as a whole", () => {
    for (const bad of ["p95 < 1s", ["< 1s"], 5]) {
      const e = thrown(() => parseThresholds(bad as never));
      expect(e.exitCode).toBe(ExitCode.ConfigInvalid);
      expect(e.message).toMatch(/^thresholds: expected a mapping/);
    }
  });

  it("abortOnFail must be a boolean", () => {
    const e = thrown(() => parseThresholds({ "http.p95": { expr: "< 1s", abortOnFail: "yes" as never } }));
    expect(e.message).toMatch(/thresholds\.http\.p95\.abortOnFail: expected true or false/);
  });

  it("a bad delayAbortEval names its path once", () => {
    const e = thrown(() => parseThresholds({ "http.p95": { expr: "< 1s", delayAbortEval: "soon" } }));
    expect(e.message).toBe('thresholds.http.p95.delayAbortEval: Invalid duration "soon"');
  });

  it("bad expressions keep the key path", () => {
    const e = thrown(() => parseThresholds({ "http.p95": "< banana" }));
    expect(e.message).toMatch(/^thresholds\.http\.p95: Invalid threshold/);
    expect(e.code).toBe("SW_CONFIG_THRESHOLD");
  });
});

describe("units", () => {
  it("non-finite numbers are printed as such, not as null", () => {
    expect(thrown(() => parseDuration(Number.NaN, "x.y")).message).toBe("x.y: Invalid duration NaN");
    expect(thrown(() => parseDuration(Number.POSITIVE_INFINITY)).message).toBe("Invalid duration Infinity");
  });
});

describe("config is not a prototype-pollution vector (security boundary)", () => {
  it("--set, env and file layers ignore __proto__ / constructor / prototype", async () => {
    parseSetArgs(["__proto__.swPolluted=1", "constructor.prototype.swPolluted2=1"]);
    const r = await loadConfig({
      inline: JSON.parse('{"safety":{"__proto__":{"allowPublic":true}}}') as Record<string, unknown>,
      userConfig: false,
      env: { SW_CONSTRUCTOR__PROTOTYPE__SW_POLLUTED3: "1" },
    });
    expect(r.config.safety.allowPublic).toBe(false);
    const probe = {} as Record<string, unknown>;
    expect(probe.swPolluted).toBeUndefined();
    expect(probe.swPolluted2).toBeUndefined();
    expect(probe.swPolluted3).toBeUndefined();
    expect(probe.allowPublic).toBeUndefined();
  });
});
