/** `sw agent` wiring: budget/flag parsing, input merging, and the fast refusal paths. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentInputFromFlags, exportSuggestedTests, parseBudget } from "../../../src/cli/commands/agent.js";
import { loadConfig } from "../../../src/core/config/loader.js";
import { buildAgentInput } from "../../../src/core/world.js";
import { runCli } from "../../helpers/cli.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

describe("agent flag parsing", () => {
  it("parseBudget", () => {
    expect(parseBudget("requests=500, iterations=100,time=2m,patience=30")).toEqual({
      maxRequests: 500,
      maxIterations: 100,
      maxDuration: 120_000,
      patience: 30,
    });
    expect(parseBudget("rps=20,concurrency=4,duration=30s")).toEqual({
      maxRps: 20,
      maxConcurrency: 4,
      maxDuration: 30_000,
    });
    for (const bad of ["requests", "requests=0", "requests=x", "speed=3", "time=soon"])
      expect(() => parseBudget(bad), bad).toThrow();
  });

  it("agentInputFromFlags", () => {
    expect(
      agentInputFromFlags(
        {
          bandit: "thompson",
          techniques: "ownership,boundary",
          budget: "requests=50",
          allowMutations: true,
          allowDestructive: true,
          include: ["GET /orders/*"],
          context: ["r.json"],
        },
        "/w",
      ),
    ).toEqual({
      bandit: "thompson",
      techniques: ["ownership", "boundary"],
      budget: { maxRequests: 50 },
      allowMutations: true,
      allowDestructive: true,
      operations: { include: ["GET /orders/*"] },
      context: { files: [expect.stringMatching(/r\.json$/)] },
    });
  });

  it("exportSuggestedTests writes basenames only", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-agent-exp-"));
    const files = exportSuggestedTests(dir, [
      { filename: "../../evil/agent-bola-get.test.ts", vitest: "export {};\n" },
    ]);
    expect(files).toEqual([join(dir, "agent-bola-get.test.ts")]);
    expect(readFileSync(files[0] as string, "utf8")).toBe("export {};\n");
  });
});

describe("buildAgentInput", () => {
  it("falls back to the bugs section (contract → openapi, roles, hooks); agent section wins; secrets resolved", async () => {
    const cfg = await loadConfig({
      env: {},
      userConfig: false,
      inline: {
        targets: { api: { url: "http://127.0.0.1:3000" } },
        auth: { user: { type: "bearer", token: { env: "TOK" } }, other: { type: "bearer", token: "bob" } },
        hooks: { reset: { http: { method: "POST", url: "http://127.0.0.1:3000/__reset" } } },
        bugs: {
          contract: "./openapi.yaml",
          values: { sku: ["A"] },
          headers: { "x-test": "1" },
          propertyRuns: 9,
        },
        agent: {
          planner: "heuristic",
          budget: { maxRequests: 100 },
          auth: { roles: { admin: { type: "bearer", token: { env: "ADM" } } } },
        },
      },
    });
    const input = buildAgentInput(
      cfg,
      { budget: { maxIterations: 5 } },
      { seed: 4, env: { TOK: "alice", ADM: "root" } },
    );
    expect(input).toMatchObject({
      target: "http://127.0.0.1:3000",
      openapi: "./openapi.yaml",
      cwd: cfg.cwd,
      seed: 4,
      values: { sku: ["A"] },
      headers: { "x-test": "1" },
      hooks: { reset: { http: { method: "POST" } } },
      planner: "heuristic",
      budget: { maxRequests: 100, maxIterations: 5 },
    });
    // agent.auth.roles deep-merges over the config.auth-derived roles, all resolved
    expect((input.auth as { roles: Record<string, unknown> }).roles).toEqual({
      user: { type: "bearer", token: "alice" },
      other: { type: "bearer", token: "bob" },
      admin: { type: "bearer", token: "root" },
    });
    expect(input).not.toHaveProperty("propertyRuns");
  });
});

describe("sw agent refusals (subprocess)", () => {
  function project(cfg: object): string {
    const dir = mkdtempSync(join(tmpdir(), "sw-agent-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "sw.config.json"), JSON.stringify(cfg));
    return dir;
  }
  const cfg = { targets: { api: { url: "http://127.0.0.1:9" } }, bugs: { contract: "./openapi.yaml" } };

  it("has no AI planner option (--planner is rejected)", async () => {
    const r = await runCli(["agent", "--planner", "llm", "--no-history"], { cwd: project(cfg), env });
    expect(r.exitCode, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/unknown option '--planner'/);
  });

  it("--allow-destructive without --yes → exit 3", async () => {
    const r = await runCli(["agent", "--allow-destructive", "--no-history"], { cwd: project(cfg), env });
    expect(r.exitCode, r.stderr).toBe(3);
    expect(r.stderr).toMatch(/SW_SAFETY_APPROVAL_REQUIRED/);
  });
});
