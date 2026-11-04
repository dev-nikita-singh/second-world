import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import { apiVersionProblem, definePlugin, namespaceOf, qualifyId } from "../../../src/core/plugins/define.js";
import * as entry from "../../../src/plugin.js";

describe("apiVersion check (docs/10 §3)", () => {
  it("accepts the current version as number or matching semver range", () => {
    expect(apiVersionProblem(1)).toBeUndefined();
    expect(apiVersionProblem("^1")).toBeUndefined();
    expect(apiVersionProblem(">=1 <2")).toBeUndefined();
  });

  it("rejects other versions, bad ranges and a missing apiVersion with a clear message", () => {
    expect(apiVersionProblem(2)).toMatch(/needs plugin API 2, this SECOND WORLD provides plugin API 1/);
    expect(apiVersionProblem("^2")).toMatch(/needs plugin API "\^2"/);
    expect(apiVersionProblem("banana")).toMatch(/not a semver range/);
    expect(apiVersionProblem(undefined)).toMatch(/apiVersion is missing/);
    expect(apiVersionProblem(1.5)).toMatch(/not a valid version/);
  });
});

describe("definePlugin", () => {
  it("returns the definition unchanged", () => {
    const def = { name: "x", apiVersion: 1, setup() {} };
    expect(definePlugin(def)).toBe(def);
  });

  it("throws ConfigError SW_CONFIG_PLUGIN_API_VERSION / _INVALID naming the plugin", () => {
    const bad = () => definePlugin({ name: "@acme/old", apiVersion: 3, setup() {} });
    expect(bad).toThrow(ConfigError);
    expect(bad).toThrow(/plugin "@acme\/old": needs plugin API 3/);
    try {
      bad();
    } catch (e) {
      expect((e as ConfigError).code).toBe("SW_CONFIG_PLUGIN_API_VERSION");
      expect((e as ConfigError).exitCode).toBe(2);
    }
    try {
      definePlugin({ name: "", apiVersion: 1 } as never);
    } catch (e) {
      expect((e as ConfigError).code).toBe("SW_CONFIG_PLUGIN_INVALID");
      expect((e as Error).message).toMatch(
        /name must be a non-empty string; setup\(api\) must be a function/,
      );
    }
  });
});

describe("namespacing", () => {
  it("derives the namespace from the package name", () => {
    expect(namespaceOf({ name: "@acme/sw-grpc" })).toBe("acme");
    expect(namespaceOf({ name: "sw-plugin-foo" })).toBe("foo");
    expect(namespaceOf({ name: "second-world-plugin-bar" })).toBe("bar");
    expect(namespaceOf({ name: "Local Plugin" })).toBe("local-plugin");
    expect(namespaceOf({ name: "@acme/x", namespace: "custom" })).toBe("custom");
  });

  it("prefixes bare ids, keeps own-namespace ids, rejects foreign namespaces", () => {
    expect(qualifyId("acme", "summary", "reporter")).toBe("acme/summary");
    expect(qualifyId("acme", "acme/summary", "reporter")).toBe("acme/summary");
    expect(() => qualifyId("acme", "other/summary", "reporter")).toThrow(
      /outside the plugin's namespace "acme"/,
    );
    expect(() => qualifyId("acme", "", "reporter")).toThrow(/non-empty/);
    expect(() => qualifyId("acme", "has space", "rule")).toThrow(/must match/);
  });
});

describe("second-world/plugin entry (src/plugin.ts)", () => {
  it("exports definePlugin, the API version and the AST rule helpers", () => {
    expect(Object.keys(entry).sort()).toEqual(
      [
        "PLUGIN_API_VERSION",
        "PLUGIN_HOOK_EVENTS",
        "apiVersionProblem",
        "definePlugin",
        "defineTsRule",
        "namespaceOf",
        "ruleMeta",
      ].sort(),
    );
    expect(entry.PLUGIN_API_VERSION).toBe(1);
    expect(entry.PLUGIN_HOOK_EVENTS).toEqual([
      "config.resolved",
      "run.started",
      "engine.started",
      "finding.created",
      "run.completed",
      "run.failed",
    ]);
  });
});
