/**
 * System test: the orchestrator through the public API (`createWorld` → `world.run(workflow)`),
 * docs/02-architecture.md §4.2, docs/09-cli-and-api.md §2.
 * DAG: architecture → performance → performance (downstream), plus a failing step with
 * `continueOnError` (its dependant still runs), a failing step without it (its dependant is
 * skipped) and an optional failing step (does not fail the workflow by itself).
 * Owner: sw-qa.
 */
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, createWorld, type World } from "../../src/index.js";
import { type RunningExample, startExample } from "../helpers/examples.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";
import { EXAMPLES_DIR, expectTrustLadder } from "./helpers.js";

const PROJECT = path.join(EXAMPLES_DIR, "shop-express");

let tmp: TmpDir;
let shop: RunningExample;
let world: World;

const perfInput = (p: string) => ({
  model: "iterations",
  iterations: 40,
  vus: 4,
  warmup: 0,
  scenarios: [{ name: "get", steps: [{ method: "GET", path: p, expect: { status: 200 } }] }],
});

beforeAll(async () => {
  tmp = await makeTmpDir("sw-sys-wf-");
  shop = await startExample("shop-express");
  world = await createWorld({
    cwd: tmp.path,
    probe: false,
    auditFile: false,
    userConfig: false,
    config: {
      targets: { api: { url: shop.url } },
      safety: { allowHosts: ["127.0.0.1"] },
      workflows: {
        investigate: {
          concurrency: 2,
          steps: {
            arch: { engine: "architecture", input: { project: PROJECT, cacheDir: tmp.join("cache") } },
            perf: { engine: "performance", after: ["arch"], input: perfInput("/products/1") },
            // bugs with a contract that does not exist → throws a ConfigError
            broken: { engine: "bugs", continueOnError: true, input: { openapi: tmp.join("missing.yaml") } },
            afterBroken: { engine: "performance", after: ["broken"], input: perfInput("/healthz") },
            strict: { engine: "bugs", input: { openapi: tmp.join("missing.yaml") } },
            afterStrict: { engine: "performance", after: ["strict"], input: perfInput("/healthz") },
            maybe: { engine: "no-such-engine", optional: true },
            final: { engine: "performance", after: ["perf", "maybe"], input: perfInput("/products") },
          },
        },
        cyclic: {
          steps: {
            a: { engine: "performance", after: ["b"] },
            b: { engine: "performance", after: ["a"] },
          },
        },
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await world?.close();
  await shop?.close();
  await tmp?.cleanup();
});

describe("world.run(workflow) — DAG orchestration", () => {
  it("runs the DAG in dependency order, isolates failures, passes over continueOnError/optional", async () => {
    const started: string[] = [];
    world.on("run.started", (p) => started.push((p as { engine: string }).engine));
    const r = await world.run("investigate");

    // topological order respects every edge
    const pos = (id: string) => r.order.indexOf(id);
    expect(pos("arch")).toBeLessThan(pos("perf"));
    expect(pos("perf")).toBeLessThan(pos("final"));
    expect(pos("broken")).toBeLessThan(pos("afterBroken"));

    const st = (id: string) => r.steps[id]?.status;
    expect(st("arch")).toBe("ok");
    expect(st("perf")).toBe("ok");
    expect(st("broken")).toBe("failed");
    expect(st("afterBroken")).toBe("ok"); // continueOnError passes control on
    expect(st("strict")).toBe("failed");
    expect(st("afterStrict")).toBe("skipped"); // no continueOnError → dependant skipped
    expect(st("maybe")).toBe("failed");
    expect(st("final")).toBe("ok"); // optional upstream failure does not block
    expect(r.ok).toBe(false); // non-optional steps failed

    const broken = r.steps.broken as { status: "failed"; error: unknown };
    expect(broken.error).toBeInstanceOf(ConfigError);

    // each finished engine result reached the evidence store
    const results = world.evidence.results();
    const engines = results.map((x) => x.engine);
    expect(engines.filter((e) => e === "performance")).toHaveLength(3);
    expect(engines).toContain("architecture");
    expectTrustLadder(results);
    // run.started fired for every step that reached an engine (not for skipped ones)
    expect(started.filter((e) => e === "performance")).toHaveLength(3);
    expect(started).toContain("architecture");
    const arch = results.find((x) => x.engine === "architecture");
    expect(arch?.findings.length).toBeGreaterThan(0);
    for (const f of arch?.findings ?? []) expect(world.evidence.get(f.id)).toBeDefined();
  }, 120_000);

  it("rejects a cyclic workflow and an unknown workflow before running anything", async () => {
    await expect(world.run("cyclic")).rejects.toThrow(/cycle/i);
    await expect(world.run("nope")).rejects.toBeInstanceOf(ConfigError);
  });
});
