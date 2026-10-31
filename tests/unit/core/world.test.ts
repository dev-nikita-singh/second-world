import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError } from "../../../src/core/errors.js";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { createFinding } from "../../../src/core/evidence/store.js";
import { planWorkflow, runWorkflow } from "../../../src/core/orchestrator.js";
import { createRegistry, engineFromModule } from "../../../src/core/registry.js";
import type { Engine } from "../../../src/core/types.js";
import { buildPerformanceInput, createWorld } from "../../../src/core/world.js";

function result(engine: EngineResult["engine"], status: EngineResult["status"] = "passed"): EngineResult {
  return {
    schemaVersion: 1,
    engine,
    runId: "r",
    status,
    startedAt: "a",
    endedAt: "b",
    findings: [],
    limitations: [],
    artifacts: [],
  };
}

const fakeEngine: Engine<{ n: number }, { doubled: number }> = {
  id: "bugs",
  version: "0",
  inputSchema: z.object({ n: z.number().default(1) }),
  requires: [],
  async run(input, ctx) {
    ctx.events.emit("bugs.tick", input.n);
    const f = createFinding(
      {
        engine: "bugs",
        category: "bug",
        title: "x",
        severity: "low",
        classification: "observation",
        confidence: 1,
        evidence: [{ kind: "note", text: "n" }],
      },
      ctx,
    );
    return { ...result("bugs"), findings: [f], data: { doubled: input.n * 2 } };
  },
};

describe("registry", () => {
  it("loads lazily once and finds the engine export", async () => {
    let loads = 0;
    const reg = createRegistry({
      bugs: async () => {
        loads++;
        return { bugsEngine: fakeEngine };
      },
    });
    expect(reg.isLoaded("bugs")).toBe(false);
    const a = await reg.load("bugs");
    const b = await reg.load("bugs");
    expect(a.engine).toBe(fakeEngine);
    expect(b.engine).toBe(fakeEngine);
    expect(loads).toBe(1);
    await expect(reg.load("nope")).rejects.toMatchObject({ code: "SW_CAP_ENGINE_UNAVAILABLE", exitCode: 4 });
    expect(engineFromModule({ default: fakeEngine }, "bugs")).toBe(fakeEngine);
    expect(engineFromModule({ x: 1 }, "bugs")).toBeUndefined();
  });
  it("built-in performance engine resolves", async () => {
    const { engine } = await createRegistry().load("performance");
    expect(engine.id).toBe("performance");
  });
  it("loader failures become EngineError and are retryable", async () => {
    let n = 0;
    const reg = createRegistry({
      bugs: async () => {
        if (n++ === 0) throw new Error("boom");
        return fakeEngine;
      },
    });
    await expect(reg.load("bugs")).rejects.toMatchObject({ code: "SW_ENGINE_LOAD" });
    await new Promise((r) => setTimeout(r, 0));
    expect((await reg.load("bugs")).engine).toBe(fakeEngine);
  });
});

describe("orchestrator", () => {
  it("plans in topological order and rejects cycles / unknown deps", () => {
    expect(
      planWorkflow({
        c: { engine: "x", after: ["a", "b"] },
        a: { engine: "x" },
        b: { engine: "x", after: ["a"] },
      }),
    ).toEqual(["a", "b", "c"]);
    expect(() =>
      planWorkflow({ a: { engine: "x", after: ["b"] }, b: { engine: "x", after: ["a"] } }),
    ).toThrow(/cycle/);
    expect(() => planWorkflow({ a: { engine: "x", after: ["zz"] } })).toThrow(ConfigError);
  });
  it("runs in parallel with a limit, passes upstream results, skips dependants of failures", async () => {
    let running = 0;
    let maxRunning = 0;
    const seen: Record<string, string[]> = {};
    const wf = await runWorkflow(
      {
        a: { engine: "performance" },
        b: { engine: "performance" },
        c: { engine: "performance" },
        bad: { engine: "performance" },
        afterBad: { engine: "performance", after: ["bad"] },
        optionalBad: { engine: "performance", optional: true },
        afterOptional: { engine: "performance", after: ["optionalBad", "a"] },
      },
      async (id, _s, upstream) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        seen[id] = Object.keys(upstream);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        if (id === "bad" || id === "optionalBad") throw new Error("fail");
        return result("performance");
      },
      { concurrency: 2 },
    );
    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(wf.steps.afterBad).toMatchObject({ status: "skipped" });
    expect(wf.steps.afterOptional).toMatchObject({ status: "ok" });
    expect(seen.afterOptional).toEqual(["a"]);
    expect(wf.ok).toBe(false);
  });
});

describe("world", () => {
  it("runs a registered engine with config section merge, events and evidence", async () => {
    const world = await createWorld({
      config: { bugs: { n: 2 } },
      env: {},
      probe: false,
      engines: { bugs: async () => fakeEngine },
    });
    const ticks: unknown[] = [];
    world.on("bugs.tick", (n) => ticks.push(n));
    const created: unknown[] = [];
    world.on("finding.created", (f) => created.push(f));
    const r = await world.engine("bugs").run({});
    expect(r.data).toEqual({ doubled: 4 });
    expect(ticks).toEqual([2]);
    expect(created).toHaveLength(1);
    expect(world.evidence.findings()[0]?.occurrences).toBe(1);
    await expect(world.engine("bugs").run({ n: "x" })).rejects.toBeInstanceOf(ConfigError);
    await expect(world.run("nope")).rejects.toThrow(/Unknown workflow/);
    await world.close();
    await expect(world.engine("bugs").run()).rejects.toThrow(/closed/);
  });

  it("runs workflows from config", async () => {
    const world = await createWorld({
      config: {
        workflows: {
          w: { steps: { one: { engine: "bugs" }, two: { engine: "bugs", after: ["one"], input: { n: 5 } } } },
        },
      },
      env: {},
      probe: false,
      engines: { bugs: async () => fakeEngine },
    });
    const wf = await world.run("w");
    expect(wf.ok).toBe(true);
    expect(wf.order).toEqual(["one", "two"]);
    await world.close();
  });

  it("buildPerformanceInput resolves targets, units, auth secrets", async () => {
    const world = await createWorld({
      config: {
        targets: { api: { url: "http://127.0.0.1:3000" } },
        auth: { user: { type: "bearer", token: { env: "TOK" } } },
        performance: { target: "api", rate: "120/m", duration: "2s" },
      },
      env: { TOK: "tok-123456" },
      probe: false,
    });
    const input = buildPerformanceInput(
      world.config,
      { auth: "user" },
      { seed: 7, env: { TOK: "tok-123456" } },
    );
    expect(input).toMatchObject({
      target: "http://127.0.0.1:3000",
      rate: 2,
      duration: 2000,
      seed: 7,
      auth: { type: "bearer", token: "tok-123456" },
    });
    expect(world.redactor.redactString("x tok-123456")).not.toContain("tok-123456");
    await world.close();
  });

  describe("performance end-to-end (real engine, local server)", () => {
    let server: Server;
    let url: string;
    beforeAll(async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("world.performance.run returns a result and records evidence", async () => {
      const world = await createWorld({ config: false, env: {}, probe: false, auditFile: false });
      const r = await world.performance.run({ target: url, model: "iterations", iterations: 20, vus: 2 });
      expect(["passed", "failed"]).toContain(r.status);
      expect(world.evidence.results()).toHaveLength(1);
      await world.close();
    });

    it("public targets are blocked by safety (exit 3)", async () => {
      const world = await createWorld({ config: false, env: {}, probe: false, auditFile: false });
      await expect(
        world.performance.run({ target: "https://example.com/", model: "iterations", iterations: 1, vus: 1 }),
      ).rejects.toMatchObject({ exitCode: 3 });
      await world.close();
    });

    it("cancel() aborts a run → cancelled status", async () => {
      const world = await createWorld({ config: false, env: {}, probe: false, auditFile: false });
      const p = world.performance.run({ target: url, model: "closed", vus: 2, duration: "10s" });
      setTimeout(() => world.cancel(), 300);
      const r = await p;
      expect(r.status).toBe("cancelled");
      await world.close();
    });
  });
});
