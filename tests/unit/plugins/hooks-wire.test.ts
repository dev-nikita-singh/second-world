import { describe, expect, it } from "vitest";
import { createHookRunner } from "../../../src/core/plugins/hooks.js";
import { disabledPluginSet, loadPlugins, type PluginSet } from "../../../src/core/plugins/index.js";
import {
  assertHistoryStore,
  bindPluginAssertions,
  renderPluginReport,
} from "../../../src/core/plugins/wire.js";

describe("hook runner", () => {
  it("runs handlers in registration order and isolates failures with the plugin name", async () => {
    const calls: string[] = [];
    const h = createHookRunner({ timeoutMs: 50 });
    h.on("a", "run.started", () => {
      calls.push("a");
    });
    h.on("b", "run.started", () => {
      throw new Error("nope");
    });
    h.on("c", "run.started", async () => {
      calls.push("c");
    });
    h.on("d", "run.started", () => new Promise(() => {}));
    expect(h.has("run.started")).toBe(true);
    expect(h.has("run.failed")).toBe(false);
    const fails = await h.run("run.started", { engine: "bugs" });
    expect(calls).toEqual(["a", "c"]);
    expect(fails).toEqual([
      { plugin: "b", event: "run.started", message: 'plugin "b" hook run.started failed: nope' },
      {
        plugin: "d",
        event: "run.started",
        message: 'plugin "d" hook run.started failed: hook run.started did not finish within 50 ms',
      },
    ]);
    expect(h.eventsOf("a")).toEqual(["run.started"]);
  });
});

async function setWithAssertion(): Promise<PluginSet> {
  return loadPlugins(
    [
      {
        spec: "a",
        optional: false,
        options: { strict: true },
        inline: {
          name: "@acme/a",
          apiVersion: 1,
          setup(api) {
            api.registerAssertion("min-len", (res, args, ctx) => {
              if (ctx.options.strict !== true) return "options not passed";
              const n = Array.isArray(res.body) ? res.body.length : 0;
              if (n === 99) throw new Error("exploded");
              return n >= Number(args.min) || `only ${n} items`;
            });
            api.registerReporter("upper", {
              render: (r) => String((r as { verdict: string }).verdict).toUpperCase(),
            });
            api.registerReporter("bad", { render: () => 42 as never });
            api.registerReporter("throws", {
              render: () => {
                throw new Error("render broke");
              },
            });
          },
        },
      },
    ],
    { projectDir: process.cwd() },
  );
}

describe("bindPluginAssertions", () => {
  it("keeps built-in assertions and binds `use` entries to the plugin with args and options", async () => {
    const set = await setWithAssertion();
    const builtinA = { operation: "GET /x", status: 200 };
    const { builtin, bound } = bindPluginAssertions(set, [
      builtinA,
      { operation: "GET /items", use: "acme/min-len", args: { min: 2 }, name: "at least two" },
    ]);
    expect(builtin).toEqual([builtinA]);
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({ name: "at least two", kind: "assertion", operations: ["GET /items"] });
    const ex = { operation: "GET /items", method: "GET", url: "u", status: 200, headers: {} };
    expect(await bound[0]?.fn({ ...ex, body: [1] })).toBe("only 1 items");
    expect(await bound[0]?.fn({ ...ex, body: [1, 2] })).toBe(true);
    await expect(bound[0]?.fn({ ...ex, body: new Array(99).fill(0) })).rejects.toThrow(
      'plugin "@acme/a": exploded',
    );
  });

  it("rejects unknown ids and malformed entries with the config path", async () => {
    const set = await setWithAssertion();
    expect(() => bindPluginAssertions(set, [{ operation: "GET /x", use: "acme/nope" }])).toThrow(
      'bugs.assertions.0.use: unknown plugin assertion "acme/nope"',
    );
    expect(() => bindPluginAssertions(set, [{ use: "acme/min-len" }])).toThrow(/bugs.assertions.0.operation/);
    expect(() =>
      bindPluginAssertions(set, [{ operation: "GET /x", use: "acme/min-len", status: 200 }]),
    ).toThrow(/unknown: status/);
    expect(() =>
      bindPluginAssertions(set, [{ operation: "GET /x", use: "acme/min-len", args: [1] }]),
    ).toThrow(/args: expected an object/);
    try {
      bindPluginAssertions(disabledPluginSet([], "--no-plugins"), [
        { operation: "GET /x", use: "acme/min-len" },
      ]);
    } catch (e) {
      expect((e as { hint: string }).hint).toMatch(/Plugins are disabled/);
    }
  });
});

describe("renderPluginReport / assertHistoryStore", () => {
  it("renders, and wraps reporter failures with the plugin name", async () => {
    const set = await setWithAssertion();
    expect(await renderPluginReport(set.reporters.get("acme/upper") as never, { verdict: "failed" })).toBe(
      "FAILED",
    );
    await expect(renderPluginReport(set.reporters.get("acme/bad") as never, {})).rejects.toThrow(
      'plugin "@acme/a" reporter acme/bad returned number, expected a string',
    );
    await expect(renderPluginReport(set.reporters.get("acme/throws") as never, {})).rejects.toThrow(
      'plugin "@acme/a" reporter acme/throws failed: render broke',
    );
  });

  it("checks the HistoryStore interface", () => {
    expect(() => assertHistoryStore({ append() {} }, "p", "p/s")).toThrow(
      'plugin "p" history store p/s does not implement HistoryStore (missing: get, list, query, setBaseline, getBaseline, listBaselines, diff, trend, verify, prune)',
    );
    expect(() => assertHistoryStore(null, "p", "p/s")).toThrow(/missing: append/);
  });
});
