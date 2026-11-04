import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../../src/core/config/schema.js";
import { CapabilityError, ConfigError } from "../../../src/core/errors.js";
import {
  disabledPluginSet,
  firstFailure,
  loadPlugins,
  normalizePluginEntries,
  type PluginExport,
  type PluginSpec,
  pluginError,
} from "../../../src/core/plugins/index.js";
import { defineTsRule, ruleMeta } from "../../../src/plugin.js";
import { makePluginProject, type PluginProject } from "./project.js";

let proj: PluginProject;
beforeAll(async () => {
  proj = await makePluginProject();
});
afterAll(async () => {
  await proj.cleanup();
});

const inline = (x: PluginExport, optional = false, options: Record<string, unknown> = {}): PluginSpec => ({
  spec: typeof x === "object" ? x.name : "factory",
  optional,
  options,
  inline: x,
});

describe("config schema: plugins section", () => {
  it("accepts strings and { name, optional, options } and rejects unknown keys", () => {
    const c = ConfigSchema.parse({
      plugins: ["@acme/sw-extras", { name: "./p.mjs", optional: true, options: { a: 1 } }],
    });
    expect(c.plugins).toEqual(["@acme/sw-extras", { name: "./p.mjs", optional: true, options: { a: 1 } }]);
    expect(normalizePluginEntries(c.plugins)).toEqual([
      { spec: "@acme/sw-extras", optional: false, options: {} },
      { spec: "./p.mjs", optional: true, options: { a: 1 } },
    ]);
    expect(ConfigSchema.safeParse({ plugins: [{ name: "x", opitonal: true }] }).success).toBe(false);
  });

  it("report.formats and history.backend accept namespaced plugin ids only", () => {
    expect(ConfigSchema.parse({ report: { formats: ["json", "acme/summary"] } }).report.formats).toEqual([
      "json",
      "acme/summary",
    ]);
    expect(ConfigSchema.safeParse({ report: { formats: ["jsno"] } }).success).toBe(false);
    expect(ConfigSchema.parse({ history: { backend: "acme/file" } }).history.backend).toBe("acme/file");
    expect(ConfigSchema.safeParse({ history: { backend: "s3" } }).success).toBe(false);
  });
});

describe("loadPlugins", () => {
  it("loads packages from the project's node_modules with namespaced contributions", async () => {
    const set = await loadPlugins(
      normalizePluginEntries([
        "@acme/sw-extras",
        { name: "sw-plugin-cjs", options: { prefix: "> " } },
        "./plugins/local-plugin.mjs",
      ]),
      { projectDir: proj.path },
    );
    expect(firstFailure(set)).toBeUndefined();
    const [acme, cjs, local] = set.plugins;
    expect(acme).toMatchObject({
      name: "@acme/sw-extras",
      version: "1.2.3",
      apiVersion: 1,
      namespace: "acme",
      status: "loaded",
      path: proj.join("node_modules", "@acme", "sw-extras", "index.mjs"),
    });
    expect(acme?.contributions).toEqual([
      { kind: "reporter", id: "acme/summary" },
      { kind: "rule", id: "acme/no-legacy-files" },
      { kind: "assertion", id: "acme/sorted-by" },
      { kind: "historyStore", id: "acme/file" },
    ]);
    expect(acme?.hooks).toEqual([
      "config.resolved",
      "run.started",
      "engine.started",
      "finding.created",
      "run.completed",
      "run.failed",
    ]);
    expect(cjs).toMatchObject({
      name: "sw-plugin-cjs",
      namespace: "cjs",
      apiVersion: "^1",
      status: "loaded",
    });
    expect(local).toMatchObject({ name: "local-plugin", namespace: "local-plugin", status: "loaded" });
    expect([...set.reporters.keys()]).toEqual(["acme/summary", "cjs/lines", "local-plugin/count"]);
    expect(set.reporters.get("cjs/lines")?.extension).toBe(".cjs-lines.txt");
    // factory got its options
    expect(
      await set.reporters
        .get("cjs/lines")
        ?.render({ verdict: { passed: true } }, { format: "cjs/lines", options: {} }),
    ).toBe("> passed\n");
    expect(set.rules.map((r) => r.meta.id)).toEqual(["acme/no-legacy-files"]);
    // wrapped rule rewrites its report ids to the namespaced id
    const reports = set.rules[0]?.check({ facts: [{ file: "src/legacy.ts" }, { file: "src/ok.ts" }] }) as {
      ruleId: string;
    }[];
    expect(reports.map((r) => r.ruleId)).toEqual(["acme/no-legacy-files"]);
  });

  it("a broken required plugin fails with its name; the others still load", async () => {
    const set = await loadPlugins(
      [
        inline({ name: "wrong-api", apiVersion: 2, setup() {} }),
        ...normalizePluginEntries(["./plugins/local-plugin.mjs"]),
      ],
      { projectDir: proj.path },
    );
    const f = firstFailure(set);
    expect(f).toMatchObject({ name: "wrong-api", status: "failed", apiVersion: 2 });
    expect(f?.error).toMatchObject({ code: "SW_CONFIG_PLUGIN_API_VERSION", exitCode: 2 });
    expect(f?.error?.message).toBe(
      'plugin "wrong-api": needs plugin API 2, this SECOND WORLD provides plugin API 1',
    );
    const err = pluginError(f as NonNullable<typeof f>);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.details).toEqual({ plugin: "wrong-api", spec: "wrong-api" });
    expect(set.plugins[1]?.status).toBe("loaded");
  });

  it("wraps setup errors, import errors and missing packages with the plugin name", async () => {
    const set = await loadPlugins(
      [
        inline({
          name: "throws",
          apiVersion: 1,
          setup() {
            throw new TypeError("boom");
          },
        }),
        ...normalizePluginEntries(["@acme/not-installed", "./plugins/broken-plugins.mjs"]),
      ],
      { projectDir: proj.path },
    );
    expect(set.plugins.map((p) => [p.status, p.error?.code, p.error?.message])).toEqual([
      ["failed", "SW_CONFIG_PLUGIN_SETUP", 'plugin "throws": boom'],
      [
        "failed",
        "SW_CONFIG_PLUGIN_NOT_FOUND",
        expect.stringMatching(/^plugin "@acme\/not-installed" is not installed in the project/),
      ],
      [
        "failed",
        "SW_CONFIG_PLUGIN_INVALID",
        'plugin "./plugins/broken-plugins.mjs": name must be a non-empty string; setup(api) must be a function; apiVersion is missing (expected apiVersion: 1)',
      ],
    ]);
    const imp = await loadPlugins(normalizePluginEntries(["./plugins/local-plugin.mjs"]), {
      projectDir: proj.path,
      importModule: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    expect(imp.plugins[0]?.error?.code).toBe("SW_CONFIG_PLUGIN_LOAD");
    expect(imp.plugins[0]?.error?.message).toMatch(
      /^plugin "\.\/plugins\/local-plugin\.mjs": cannot import .*Unexpected token/,
    );
  });

  it("an optional plugin degrades to a warning + limitation", async () => {
    const set = await loadPlugins(normalizePluginEntries([{ name: "@acme/not-installed", optional: true }]), {
      projectDir: proj.path,
    });
    expect(firstFailure(set)).toBeUndefined();
    expect(set.plugins[0]?.status).toBe("degraded");
    expect(set.warnings[0]).toMatch(
      /^optional plugin "@acme\/not-installed" is not installed.*continuing without it$/,
    );
    expect(set.limitations).toEqual([
      { code: "PLUGIN_DEGRADED", message: set.warnings[0], impact: "reduces-confidence" },
    ]);
  });

  it("unsupported extension points throw a clear 'not supported in 0.x' error", async () => {
    for (const point of [
      "registerExecutor",
      "registerExtractor",
      "registerFaultInjector",
      "registerEngine",
      "registerTemplateHelper",
      "registerTelemetrySource",
    ] as const) {
      const set = await loadPlugins(
        [
          inline({
            name: "p",
            apiVersion: 1,
            setup(api) {
              (api[point] as (...a: unknown[]) => never)("x", {});
            },
          }),
        ],
        { projectDir: proj.path },
      );
      expect(set.plugins[0]?.error).toMatchObject({
        code: "SW_CONFIG_PLUGIN_UNSUPPORTED",
        message: `plugin "p": ${point}() is not supported in SECOND WORLD 0.x (plugin API 1)`,
      });
    }
  });

  it("clashes are errors: same contribution id, same extension, duplicate plugin, foreign namespace", async () => {
    const rep = (name: string, ns: string, ext?: string): PluginExport => ({
      name,
      namespace: ns,
      apiVersion: 1,
      setup(api) {
        api.registerReporter("r", { ...(ext ? { extension: ext } : {}), render: () => "" });
      },
    });
    const set = await loadPlugins(
      [
        inline(rep("a", "acme")),
        inline(rep("b", "acme")),
        inline(rep("c", "other", ".acme-r.txt")),
        inline(rep("d", "dd", ".json")),
        inline(rep("a", "zzz")),
        inline({
          name: "e",
          apiVersion: 1,
          setup(api) {
            api.registerAssertion("acme/steal", () => true);
          },
        }),
        inline({
          name: "f",
          apiVersion: 1,
          setup(api) {
            api.registerAssertion("x", () => true);
            api.registerAssertion("x", () => true);
          },
        }),
      ],
      { projectDir: proj.path },
    );
    expect(set.plugins.map((p) => p.error?.message ?? "ok")).toEqual([
      "ok",
      'plugin "b": reporter "acme/r" is already registered by plugin "a"',
      'plugin "c": reporter extension ".acme-r.txt" is already registered by plugin "a"',
      'plugin "d": reporter "dd/r" extension ".json" is used by a built-in format',
      'plugin "a": is listed twice (or two packages share the name)',
      'plugin "e": assertion "acme/steal" is outside the plugin\'s namespace "e" (use "e/steal" or just "steal")',
      'plugin "f": registers assertion "f/x" twice',
    ]);
    expect(set.plugins.slice(1).every((p) => p.error?.code?.startsWith("SW_CONFIG_PLUGIN_"))).toBe(true);
    // nothing from a failed plugin is committed
    expect([...set.reporters.keys()]).toEqual(["acme/r"]);
    expect(set.assertions.size).toBe(0);
  });

  it("requires: an unavailable capability fails the plugin with a CapabilityError (exit 4)", async () => {
    const set = await loadPlugins(
      [
        inline({
          name: "needs-docker",
          apiVersion: 1,
          requires: [{ cap: "docker" }, { cap: "git", optional: true }],
          setup() {},
        }),
      ],
      {
        projectDir: proj.path,
        capabilities: {
          docker: { available: false, reason: "docker not found", fix: "install Docker" },
          git: { available: false },
        },
      },
    );
    const f = firstFailure(set);
    expect(f?.error).toMatchObject({
      code: "SW_CAP_PLUGIN_REQUIRES",
      exitCode: 4,
      message: 'plugin "needs-docker": requires capability "docker" (docker not found)',
      hint: "install Docker",
    });
    expect(pluginError(f as NonNullable<typeof f>)).toBeInstanceOf(CapabilityError);
  });

  it("defineTsRule results register extractor + rule; a bare id is rejected (hits cannot be renamed)", async () => {
    const good = defineTsRule({
      meta: ruleMeta("ts/no-eval", "No eval", "high", "security", "warn", "Do not use eval"),
      create: () => ({ CallExpression() {} }),
    });
    const bare = defineTsRule({
      meta: ruleMeta("no-eval", "No eval", "high", "security", "warn", "x"),
      create: () => ({ CallExpression() {} }),
    });
    const set = await loadPlugins(
      [
        inline({ name: "ts", apiVersion: 1, setup: (api) => api.registerRule(good) }),
        inline({ name: "ts2", namespace: "ts2", apiVersion: 1, setup: (api) => api.registerRule(bare) }),
      ],
      { projectDir: proj.path },
    );
    expect(set.plugins[0]?.status).toBe("loaded");
    expect(set.extractors.map((e) => e.id)).toEqual(["rule/ts/no-eval"]);
    expect(set.plugins[1]?.error?.message).toBe(
      'plugin "ts2": defineTsRule rule "no-eval" must use its namespaced id "ts2/no-eval" in ruleMeta(...)',
    );
  });

  it("unknown hook names and invalid contributions are setup errors", async () => {
    const set = await loadPlugins(
      [
        inline({ name: "h", apiVersion: 1, setup: (api) => api.hooks.on("run.finished" as never, () => {}) }),
        inline({ name: "r", apiVersion: 1, setup: (api) => api.registerReporter("x", {} as never) }),
        inline({ name: "s", apiVersion: 1, setup: (api) => api.registerHistoryStore("x", null as never) }),
      ],
      { projectDir: proj.path },
    );
    expect(set.plugins.map((p) => p.error?.message)).toEqual([
      expect.stringMatching(/^plugin "h": unknown hook "run.finished" \(known: config.resolved, /),
      'plugin "r": reporter "r/x" needs render(report)',
      'plugin "s": history store "s/x" must be a factory function',
    ]);
  });

  it("a hanging setup is bounded", async () => {
    const set = await loadPlugins(
      [inline({ name: "slow", apiVersion: 1, setup: () => new Promise(() => {}) })],
      { projectDir: proj.path, setupTimeoutMs: 50 },
    );
    expect(set.plugins[0]?.error?.message).toBe('plugin "slow": setup() did not finish within 50 ms');
  });

  it("disabledPluginSet lists plugins as disabled without importing anything", () => {
    const set = disabledPluginSet(normalizePluginEntries(["@acme/sw-extras"]), "--no-plugins");
    expect(set.enabled).toBe(false);
    expect(set.plugins).toEqual([
      {
        spec: "@acme/sw-extras",
        name: "@acme/sw-extras",
        optional: false,
        status: "disabled",
        contributions: [],
        hooks: [],
      },
    ]);
    expect(set.warnings).toEqual(["1 plugin(s) not loaded (--no-plugins): @acme/sw-extras"]);
  });
});
