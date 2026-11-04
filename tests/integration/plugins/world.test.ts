/**
 * End-to-end: fixture plugins installed in a temp project's node_modules, loaded through the config
 * by createWorld (docs/10-plugins-and-extensibility.md), each 0.x extension point exercised for real.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import type { Logger } from "../../../src/core/types.js";
import { createWorld, type World } from "../../../src/core/world.js";
import { definePlugin, defineTsRule, ruleMeta } from "../../../src/plugin.js";
import { type Listening, listenOnRandomPort } from "../../helpers/servers.js";
import { makePluginProject, type PluginProject } from "../../unit/plugins/project.js";

let proj: PluginProject;
let api: Listening;
const worlds: World[] = [];

const CONTRACT = {
  openapi: "3.0.3",
  info: { title: "items", version: "1" },
  paths: {
    "/items": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { id: { type: "integer" }, price: { type: "number" } },
                    required: ["id", "price"],
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

beforeAll(async () => {
  proj = await makePluginProject();
  await mkdir(proj.join("src"), { recursive: true });
  writeFileSync(proj.join("src", "legacy-billing.ts"), "export const legacy = 1;\n");
  writeFileSync(proj.join("src", "ok.ts"), "export const ok = 2;\n");
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/items")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          { id: 1, price: 30 },
          { id: 2, price: 10 },
        ]),
      ); // not sorted by price
    } else {
      res.writeHead(404).end();
    }
  });
  api = await listenOnRandomPort(server);
});

afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

afterAll(async () => {
  await api?.close();
  await proj?.cleanup();
});

function capture(): { log: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const log: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn: (m) => {
      warnings.push(m);
    },
    error() {},
    child: () => log,
  };
  return { log, warnings };
}

async function world(
  config: Record<string, unknown>,
  opts: Parameters<typeof createWorld>[0] = {},
): Promise<World> {
  const file = proj.writeConfig(config);
  const w = await createWorld({ config: file, probe: false, auditFile: false, userConfig: false, ...opts });
  worlds.push(w);
  return w;
}

const hookLog = () => proj.join("hooks.jsonl");
const readHooks = (): { event: string; engine?: string; ruleId?: string; status?: string }[] =>
  existsSync(hookLog())
    ? readFileSync(hookLog(), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

describe("architecture rules + reporter + hooks", () => {
  it("a plugin rule produces namespaced findings, a plugin reporter writes a file, hooks fire in order", async () => {
    writeFileSync(hookLog(), "");
    const w = await world({
      plugins: [{ name: "@acme/sw-extras", options: { hookLog: hookLog() } }],
      report: { formats: ["json", "acme/summary"], outDir: "out" },
      history: { enabled: false },
    });
    expect(w.plugins.enabled).toBe(true);
    expect(w.plugins.formats()).toEqual(["acme/summary"]);
    const r = (await w.architecture.inspect({ project: "." })) as EngineResult;
    const mine = r.findings.filter((f) => f.ruleId === "acme/no-legacy-files");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.title).toMatch(/Legacy file still present: .*legacy-billing\.ts/);
    expect((r.data as { rules: Record<string, string> }).rules["acme/no-legacy-files"]).toBe("warn");

    const written = await w.report.write(w.report.combine([r]));
    const summary = written.files.find((f) => f.format === "acme/summary");
    expect(summary?.path).toBe(proj.join("out", "report.summary.txt"));
    const text = readFileSync(summary?.path as string, "utf8");
    expect(text).toMatch(/^verdict: /);
    expect(text).toContain("- acme/no-legacy-files: Legacy file still present");
    expect(written.files.map((f) => f.format).sort()).toEqual(["acme/summary", "json"]);
    expect(await w.plugins.render([r], "acme/summary")).toBe(text);

    const events = readHooks();
    expect(events.map((e) => e.event)).toEqual([
      "config.resolved",
      "run.started",
      "engine.started",
      ...events.filter((e) => e.event === "finding.created").map(() => "finding.created"),
      "run.completed",
    ]);
    expect(events.find((e) => e.ruleId === "acme/no-legacy-files")).toBeDefined();
    expect(events.at(-1)).toMatchObject({ event: "run.completed", engine: "architecture" });
  }, 60_000);

  it("the rule level can be configured with its namespaced id", async () => {
    const w = await world({
      plugins: ["@acme/sw-extras"],
      architecture: { rules: { "acme/no-legacy-files": "off" } },
      history: { enabled: false },
    });
    const r = (await w.architecture.inspect({ project: "." })) as EngineResult;
    expect(r.findings.some((f) => f.ruleId === "acme/no-legacy-files")).toBe(false);
  }, 60_000);

  it("a defineTsRule AST rule from second-world/plugin runs inside the inspector (docs/10 §4)", async () => {
    writeFileSync(
      proj.join("src", "danger.ts"),
      "export function run(code: string) {\n  return eval(code);\n}\n",
    );
    const noEval = defineTsRule({
      meta: ruleMeta("sec/no-eval", "eval() call", "high", "security", "warn", "Do not evaluate strings"),
      create(api) {
        return {
          CallExpression(node) {
            const call = node as import("typescript").CallExpression;
            if (api.ts.isIdentifier(call.expression) && call.expression.text === "eval")
              api.report({ node, message: "eval() executes arbitrary code" });
          },
        };
      },
    });
    const w = await world(
      { history: { enabled: false }, architecture: { noCache: true } },
      {
        plugins: [
          definePlugin({
            name: "sec-rules",
            namespace: "sec",
            apiVersion: 1,
            setup: (a) => a.registerRule(noEval),
          }),
        ],
      },
    );
    const r = (await w.architecture.inspect({ project: "." })) as EngineResult;
    const hits = r.findings.filter((f) => f.ruleId === "sec/no-eval");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.locations[0]).toMatchObject({ file: expect.stringContaining("danger.ts"), line: 2 });
  }, 60_000);
});

describe("Bug Hunter assertions", () => {
  it("bugs.assertions[].use runs the plugin assertion and reports bugs/assertion-failed", async () => {
    const bugs = {
      target: api.url,
      openapi: CONTRACT,
      techniques: ["contract"],
      replays: 2,
      assertions: [
        { operation: "GET /items", use: "acme/sorted-by", args: { key: "price" }, name: "sorted by price" },
      ],
    };
    const w = await world({ plugins: ["@acme/sw-extras"], bugs, history: { enabled: false } });
    // dry-run input: plugin assertions are not part of the engine schema
    expect(w.buildInput("bugs").assertions).toEqual([]);
    const r = (await w.bugs.run({})) as EngineResult;
    const f = r.findings.find((x) => x.ruleId === "bugs/assertion-failed");
    expect(f, JSON.stringify(r.findings.map((x) => x.ruleId))).toBeDefined();
    expect(JSON.stringify(f)).toContain("sorted by price: items are not sorted by price (index 1)");

    const sorted = await world({
      plugins: ["@acme/sw-extras"],
      bugs: {
        ...bugs,
        assertions: [{ operation: "GET /items", use: "acme/sorted-by", args: { key: "id" } }],
      },
      history: { enabled: false },
    });
    const r2 = (await sorted.bugs.run({})) as EngineResult;
    expect(r2.findings.some((x) => x.ruleId === "bugs/assertion-failed")).toBe(false);
  }, 60_000);

  it("an unknown plugin assertion is a config error (exit 2)", async () => {
    const w = await world({
      plugins: ["@acme/sw-extras"],
      bugs: {
        target: api.url,
        openapi: CONTRACT,
        assertions: [{ operation: "GET /items", use: "acme/nope" }],
      },
    });
    await expect(w.bugs.run({})).rejects.toMatchObject({ code: "SW_CONFIG_BUGS", exitCode: 2 });
  });
});

describe("history stores", () => {
  it("history.backend: <ns>/<name> stores runs in the plugin's store", async () => {
    const w = await world({ plugins: ["@acme/sw-extras"], history: { backend: "acme/file", dir: "hist" } });
    const r = (await w.architecture.inspect({ project: "." })) as EngineResult;
    const saved = await w.history.save([r], { label: "x" });
    expect(saved).toEqual({ id: r.runId });
    expect(existsSync(proj.join("hist", "memory-store.json"))).toBe(true);
    const store = (await w.history.store()) as unknown as {
      backend: string;
      list(): Promise<{ id: string }[]>;
    };
    expect(store.backend).toBe("acme/file");
    expect((await store.list()).map((e) => e.id)).toEqual([r.runId]);
  }, 60_000);

  it("an unknown plugin store is a config error at creation; a broken store names the plugin", async () => {
    await expect(world({ plugins: ["@acme/sw-extras"], history: { backend: "acme/s3" } })).rejects.toThrow(
      'history.backend: unknown plugin history store "acme/s3"',
    );
    const w = await world(
      { history: { backend: "bad/store" } },
      {
        plugins: [
          {
            name: "bad",
            apiVersion: 1,
            setup: (a) => a.registerHistoryStore("store", () => ({ append() {} })),
          },
        ],
      },
    );
    await expect(w.history.store()).rejects.toThrow(
      /plugin "bad" history store bad\/store does not implement HistoryStore/,
    );
  });
});

describe("loading policy", () => {
  it("--no-plugins: nothing is imported, plugin contributions are skipped with warnings + a limitation", async () => {
    const { log, warnings } = capture();
    writeFileSync(hookLog(), "");
    const w = await world(
      {
        plugins: [{ name: "@acme/sw-extras", options: { hookLog: hookLog() } }],
        report: { formats: ["json", "acme/summary"], outDir: "out2" },
        history: { backend: "acme/file", dir: "hist2" },
      },
      { noPlugins: true, logger: log },
    );
    expect(w.plugins.enabled).toBe(false);
    expect(w.plugins.list()).toEqual([
      expect.objectContaining({ name: "@acme/sw-extras", status: "disabled" }),
    ]);
    expect(warnings).toContain("1 plugin(s) not loaded (--no-plugins): @acme/sw-extras");
    expect(warnings).toContain(
      'report format "acme/summary" comes from a plugin that is not loaded; skipped',
    );
    const r = (await w.architecture.inspect({ project: "." })) as EngineResult;
    expect(r.findings.some((f) => f.ruleId === "acme/no-legacy-files")).toBe(false);
    expect(r.limitations).toContainEqual(expect.objectContaining({ code: "PLUGINS_DISABLED" }));
    expect(readHooks()).toEqual([]);
    const written = await w.report.write(w.report.combine([r]));
    expect(written.files.map((f) => f.format)).toEqual(["json"]);
    await w.history.save([r]);
    expect(warnings.some((m) => m.includes('history.backend "acme/file" is provided by a plugin'))).toBe(
      true,
    );
    expect(existsSync(proj.join("hist2", "memory-store.json"))).toBe(false);
  }, 60_000);

  it("--no-config-code: plugins named by the config are never imported", async () => {
    const { log, warnings } = capture();
    const w = await world(
      { plugins: ["./plugins/does-not-exist.mjs"] }, // would fail if it were resolved
      { noConfigCode: true, logger: log },
    );
    expect(w.plugins.enabled).toBe(false);
    expect(w.plugins.list()[0]?.status).toBe("disabled");
    expect(warnings[0]).toBe("1 plugin(s) not loaded (--no-config-code): ./plugins/does-not-exist.mjs");
  });

  it("a broken required plugin fails createWorld with its name (exit 2); an optional one degrades", async () => {
    const p = world({ plugins: ["@acme/sw-extras", "./plugins/broken-plugins.mjs"] });
    await expect(p).rejects.toBeInstanceOf(ConfigError);
    await expect(p).rejects.toMatchObject({
      code: "SW_CONFIG_PLUGIN_INVALID",
      exitCode: 2,
      message: expect.stringMatching(
        /^plugin "\.\/plugins\/broken-plugins\.mjs": name must be a non-empty string/,
      ),
    });
    const { log, warnings } = capture();
    const w = await world(
      {
        plugins: ["@acme/sw-extras", { name: "@acme/not-installed", optional: true }],
        history: { enabled: false },
      },
      { logger: log },
    );
    expect(warnings[0]).toMatch(/^optional plugin "@acme\/not-installed" is not installed/);
    const r = (await w.architecture.inspect({ project: "." })) as EngineResult;
    expect(r.findings.some((f) => f.ruleId === "acme/no-legacy-files")).toBe(true);
    expect(r.limitations).toContainEqual(expect.objectContaining({ code: "PLUGIN_DEGRADED" }));
  }, 60_000);

  it("an unknown plugin report format is a config error naming the registered ones", async () => {
    await expect(
      world({ plugins: ["@acme/sw-extras"], report: { formats: ["acme/sumary"] } }),
    ).rejects.toMatchObject({
      code: "SW_CONFIG_REPORT_FORMAT",
      hint: "Plugin formats: acme/summary",
    });
  });

  it("failing hooks never fail the run: warning + PLUGIN_HOOK_FAILED limitation; run.failed fires on errors", async () => {
    const { log, warnings } = capture();
    const seen: string[] = [];
    const w = await world(
      { history: { enabled: false } },
      {
        logger: log,
        plugins: [
          {
            name: "flaky-hooks",
            apiVersion: 1,
            setup(api) {
              api.hooks.on("run.completed", () => {
                throw new Error("webhook down");
              });
              api.hooks.on("run.failed", (p) => {
                seen.push(`${p.engine}:${p.error.code}`);
              });
            },
          },
        ],
      },
    );
    const r = (await w.architecture.inspect({ project: "." })) as EngineResult;
    expect(r.status).not.toBe("error");
    expect(r.limitations).toContainEqual({
      code: "PLUGIN_HOOK_FAILED",
      message: 'plugin "flaky-hooks" hook run.completed failed: webhook down',
      impact: "informational",
    });
    expect(warnings).toContain('plugin "flaky-hooks" hook run.completed failed: webhook down');
    await expect(w.bugs.run({ target: "http://10.255.255.1/", openapi: CONTRACT })).rejects.toThrow();
    expect(seen).toEqual([expect.stringMatching(/^bugs:SW_/)]);
  }, 60_000);

  it("relative-path and CJS factory plugins work from the config", async () => {
    const w = await world({
      plugins: ["./plugins/local-plugin.mjs", { name: "sw-plugin-cjs", options: { prefix: "verdict=" } }],
      report: { formats: ["local-plugin/count", "cjs/lines"], outDir: "out3" },
    });
    const r = (await w.architecture.inspect({ project: "." })) as EngineResult;
    const written = await w.report.write(w.report.combine([r]));
    expect(written.files.map((f) => [f.format, readFileSync(f.path, "utf8")])).toEqual([
      ["local-plugin/count", "1\n"],
      ["cjs/lines", expect.stringMatching(/^verdict=(passed|failed)\n$/)],
    ]);
  }, 60_000);
});
