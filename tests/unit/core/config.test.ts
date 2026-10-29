import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  coerceValue,
  collectSecretValues,
  discoverConfigFile,
  envOverlay,
  loadConfig,
  parseSetArgs,
} from "../../../src/core/config/loader.js";
import { ConfigSchema, configJsonSchema, defineConfig } from "../../../src/core/config/schema.js";
import { ConfigError } from "../../../src/core/errors.js";

function tmp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sw-cfg-"));
  mkdirSync(join(dir, ".git"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const base = { env: {}, userConfig: false } as const;

describe("ConfigSchema", () => {
  it("applies defaults and normalises units", () => {
    const c = ConfigSchema.parse({ safety: { maxDuration: "5m", maxRps: "12000/m" } });
    expect(c.safety.maxDuration).toBe(300_000);
    expect(c.safety.maxRps).toBe(200);
    expect(c.safety.allowHosts).toContain("127.0.0.1");
    expect(c.environment).toBe("local");
    expect(c.report.failOn).toBe("high");
    expect(ConfigSchema.parse({}).safety.maxConcurrency).toBe(500);
  });
  it("rejects unknown top-level keys and bad units", () => {
    expect(ConfigSchema.safeParse({ perfomance: {} }).success).toBe(false);
    expect(ConfigSchema.safeParse({ safety: { maxDuration: "soon" } }).success).toBe(false);
  });
  it("defineConfig is identity and JSON schema exports", () => {
    const c = defineConfig({ environment: "staging" });
    expect(c).toEqual({ environment: "staging" });
    expect(configJsonSchema()).toHaveProperty("properties");
  });
});

describe("helpers", () => {
  it("coerceValue", () => {
    expect(coerceValue("true")).toBe(true);
    expect(coerceValue("42")).toBe(42);
    expect(coerceValue("1.5")).toBe(1.5);
    expect(coerceValue("[1,2]")).toEqual([1, 2]);
    expect(coerceValue("30s")).toBe("30s");
    expect(coerceValue("00000000000000000001")).toBe("00000000000000000001");
  });
  it("envOverlay maps SW_ vars and ignores unknown sections", () => {
    const { layer, sources } = envOverlay({
      SW_PERF_RATE: "200",
      SW_AI__PROVIDER: "ollama",
      SW_TARGET: "http://127.0.0.1:3000",
      SW_SAFETY__MAX_RPS: "50",
      SW_TEST_USER_TOKEN: "secret",
      SW_REPORT__FAIL_ON: "never",
      PATH: "/bin",
    });
    expect(layer).toEqual({
      performance: { rate: 200, target: "http://127.0.0.1:3000" },
      safety: { maxRps: 50 },
      report: { failOn: "never" },
    });
    expect(sources["safety.maxRps"]).toBe("env SW_SAFETY__MAX_RPS");
  });
  it("parseSetArgs", () => {
    expect(parseSetArgs(["performance.rate=200", "safety.allowHosts=[\"a\"]"])).toEqual({
      performance: { rate: 200 },
      safety: { allowHosts: ["a"] },
    });
    expect(() => parseSetArgs(["novalue"])).toThrow(ConfigError);
    expect(() => parseSetArgs(["__proto__.x=1"])).not.toThrow();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("loadConfig", () => {
  it("no config file → defaults", async () => {
    const dir = tmp({});
    const r = await loadConfig({ ...base, cwd: dir });
    expect(r.configFile).toBeUndefined();
    expect(r.config.safety.maxRps).toBe(2000);
  });

  it("discovers YAML walking up to the git root", async () => {
    const dir = tmp({ "sw.config.yaml": "environment: staging\nsafety:\n  maxRps: 100\n", "pkg/sub/.keep": "" });
    const sub = join(dir, "pkg", "sub");
    expect(discoverConfigFile(sub)).toBe(join(dir, "sw.config.yaml"));
    const r = await loadConfig({ ...base, cwd: sub });
    expect(r.config.environment).toBe("staging");
    expect(r.origins["safety.maxRps"]).toBe("sw.config.yaml");
  });

  it("loads JSON with extends chain", async () => {
    const dir = tmp({
      "base.json": JSON.stringify({ safety: { maxRps: 10, maxConcurrency: 5 } }),
      "sw.config.json": JSON.stringify({ extends: "./base.json", safety: { maxRps: 20 } }),
    });
    const r = await loadConfig({ ...base, cwd: dir });
    expect(r.config.safety.maxRps).toBe(20);
    expect(r.config.safety.maxConcurrency).toBe(5);
    expect(r.origins["safety.maxConcurrency"]).toBe("base.json");
  });

  it("loads a TS config through c12", async () => {
    const dir = tmp({
      "sw.config.ts": "const rate: number = 123;\nexport default { performance: { rate }, safety: { maxDuration: '10m' } };\n",
    });
    const r = await loadConfig({ ...base, cwd: dir });
    expect(r.config.performance).toEqual({ rate: 123 });
    expect(r.config.safety.maxDuration).toBe(600_000);
    expect(r.configFile).toBe(join(dir, "sw.config.ts"));
  });

  it("--no-config-code refuses TS configs", async () => {
    const dir = tmp({ "sw.config.ts": "export default {}" });
    await expect(loadConfig({ ...base, cwd: dir, noConfigCode: true })).rejects.toMatchObject({
      code: "SW_CONFIG_CODE_DISABLED",
      exitCode: 2,
    });
  });

  it("precedence: flags > --set > env > profile > file", async () => {
    const dir = tmp({
      "sw.config.yaml": [
        "performance: { rate: 1, duration: 10s, vus: 1, model: open }",
        "profiles:",
        "  ci: { performance: { rate: 2, duration: 20s, vus: 2 } }",
      ].join("\n"),
    });
    const r = await loadConfig({
      cwd: dir,
      userConfig: false,
      profile: "ci",
      env: { SW_PERF_RATE: "3", SW_PERF_DURATION: "30s" },
      set: ["performance.rate=4"],
      overrides: { performance: { rate: 5, iterations: undefined } },
    });
    expect(r.config.performance).toEqual({ rate: 5, duration: "30s", vus: 2, model: "open" });
    expect(r.origins["performance.rate"]).toBe("flag");
    expect(r.origins["performance.duration"]).toBe("env SW_PERF_DURATION");
    expect(r.origins["performance.vus"]).toBe("profile ci");
    expect(r.origins["performance.model"]).toBe("sw.config.yaml");
  });

  it("unknown profile → ConfigError with available list", async () => {
    const dir = tmp({ "sw.config.json": JSON.stringify({ profiles: { ci: {} } }) });
    await expect(loadConfig({ ...base, cwd: dir, profile: "nope" })).rejects.toThrow(/Unknown profile/);
  });

  it("validation errors include key path and source", async () => {
    const dir = tmp({ "sw.config.json": JSON.stringify({ safety: { maxRps: "fast" } }) });
    try {
      await loadConfig({ ...base, cwd: dir, set: ["environment=prod"] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toMatch(/safety\.maxRps/);
      expect(msg).toMatch(/sw\.config\.json/);
      expect(msg).toMatch(/environment/);
      expect(msg).toMatch(/--set/);
    }
  });

  it("missing explicit config file and YAML syntax errors", async () => {
    const dir = tmp({ "bad.yaml": "a: [1,\n" });
    await expect(loadConfig({ ...base, cwd: dir, configFile: "nope.json" })).rejects.toMatchObject({
      code: "SW_CONFIG_NOT_FOUND",
    });
    await expect(loadConfig({ ...base, cwd: dir, configFile: "bad.yaml" })).rejects.toMatchObject({
      code: "SW_CONFIG_PARSE",
    });
  });

  it("inline config and secret warnings / secret collection", async () => {
    const r = await loadConfig({
      ...base,
      inline: { auth: { user: { type: "bearer", token: { env: "TOK" } } } },
    });
    expect(collectSecretValues(r.config, { env: { TOK: "s3cret-value" } })).toEqual(["s3cret-value"]);
    const dir = tmp({ "sw.config.json": JSON.stringify({ auth: { user: { password: "hunter2hunter2" } } }) });
    const r2 = await loadConfig({ ...base, cwd: dir });
    expect(r2.warnings.join("\n")).toMatch(/auth\.user\.password/);
  });
});
