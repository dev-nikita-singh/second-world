/**
 * `sw bugs` / `sw replay` wiring: flag mapping (in-process) and the CLI against shop-express
 * started in-process (tests/helpers startExample). Everything is written into a temp cwd.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bugsInputFromFlags, parseInvariant, relocateArtifacts } from "../../../src/cli/commands/bugs.js";
import { loadConfig } from "../../../src/core/config/loader.js";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { buildBugsInput } from "../../../src/core/world.js";
import { REPO_ROOT, runCli } from "../../helpers/cli.js";
import { type RunningExample, startExample } from "../../helpers/examples.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

describe("bugs flag / config mapping", () => {
  it("parseInvariant built-ins and module paths", () => {
    expect(parseInvariant("linearizable:stock:1")).toEqual({
      kind: "linearizable",
      model: "stock",
      initial: 1,
    });
    expect(parseInvariant("linearizable:counter")).toEqual({ kind: "linearizable", model: "counter" });
    expect(parseInvariant("max-success:1")).toEqual({ kind: "max-success", max: 1 });
    expect(parseInvariant("same-response")).toEqual({ kind: "same-response" });
    expect(parseInvariant("./inv.ts")).toBe("./inv.ts");
    expect(() => parseInvariant("linearizable:queue")).toThrow(/stock/);
    expect(() => parseInvariant("max-success:x")).toThrow(/integer/);
  });
  it("bugsInputFromFlags", () => {
    expect(
      bugsInputFromFlags(
        {
          target: "http://127.0.0.1:1",
          openapi: "api.yaml",
          techniques: "contract,auth",
          replays: "5",
          maxReplays: "30",
          propertyRuns: "20",
          include: ["GET /x/*"],
          exclude: ["DELETE /x/{id}"],
          allowMutations: true,
          concurrencyTest: ["POST /orders"],
          burst: "20",
          invariant: "max-success:1",
          role: "user",
          body: '{"a":1}',
        },
        "/w",
      ),
    ).toEqual({
      target: "http://127.0.0.1:1",
      openapi: resolve("/w", "api.yaml"),
      techniques: ["contract", "auth"],
      replays: 5,
      maxReplays: 30,
      propertyRuns: 20,
      operations: { include: ["GET /x/*"], exclude: ["DELETE /x/{id}"] },
      allowMutations: true,
      concurrency: [
        {
          operation: "POST /orders",
          burst: 20,
          role: "user",
          body: { a: 1 },
          invariant: { kind: "max-success", max: 1 },
        },
      ],
    });
    expect(() => bugsInputFromFlags({ burst: "5" })).toThrow(/concurrency-test/);
    expect(() => bugsInputFromFlags({ concurrencyTest: ["POST /x"], body: "{nope" })).toThrow(/JSON/);
  });
  it("buildBugsInput maps contract → openapi, cwd, auth roles (secrets resolved), hooks, target names", async () => {
    const cfg = await loadConfig({
      env: {},
      userConfig: false,
      inline: {
        targets: { api: { url: "http://127.0.0.1:3000" } },
        auth: {
          user: { type: "bearer", token: { env: "TOK" } },
          admin: { type: "bearer", token: "admin-token", privileged: true },
          svc: { type: "oauth2-client-credentials", tokenUrl: "x" },
        },
        hooks: {
          reset: { http: { method: "POST", url: "http://127.0.0.1:3000/__reset" } },
          start: { command: ["npm", "start"] },
        },
        bugs: { target: "api", contract: "./openapi.yaml" },
      },
    });
    const input = buildBugsInput(cfg, {}, { seed: 3, env: { TOK: "alice" } });
    expect(input).toMatchObject({
      target: "http://127.0.0.1:3000",
      openapi: "./openapi.yaml",
      cwd: cfg.cwd,
      seed: 3,
      auth: {
        roles: {
          user: { type: "bearer", token: "alice" },
          admin: { type: "bearer", token: "admin-token", privileged: true },
        },
      },
      hooks: { reset: { http: { method: "POST", url: "http://127.0.0.1:3000/__reset" } } },
    });
    expect(input).not.toHaveProperty("contract");
    expect((input.auth as { roles: object }).roles).not.toHaveProperty("svc");
    expect(input.hooks).not.toHaveProperty("start");
  });
});

describe("sw bugs / sw replay vs shop-express (subprocess)", () => {
  let app: RunningExample;
  let dir: string;
  beforeAll(async () => {
    app = await startExample("shop-express");
    dir = mkdtempSync(join(tmpdir(), "sw-bugs-cli-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(
      join(dir, "sw.config.json"),
      JSON.stringify({
        targets: { api: { url: app.url } },
        auth: {
          user: { type: "bearer", token: "alice-token" },
          other: { type: "bearer", token: "bob-token" },
          admin: { type: "bearer", token: "admin-token" },
        },
        hooks: { reset: { http: { method: "POST", url: `${app.url}/__test/reset` } } },
        bugs: { contract: join(REPO_ROOT, "examples", "shop-express", "openapi.yaml") },
      }),
    );
  }, 30_000);
  afterAll(async () => {
    await app?.close();
  });

  let bolaFp = "";

  it("finds the seeded defects with --allow-mutations --yes → exit 1, reproductions persisted", async () => {
    const r = await runCli(
      [
        "--yes",
        "--seed",
        "42",
        "-f",
        "json",
        "bugs",
        "--allow-mutations",
        "--concurrency-test",
        "POST /orders",
        "--burst",
        "5",
        "--role",
        "user",
        "--body",
        '{"items":[{"productId":20,"qty":1}]}',
        "--invariant",
        "linearizable:stock:1",
        "--json",
      ],
      { cwd: dir, env, timeoutMs: 180_000 },
    );
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(1);
    const rep = JSON.parse(r.stdout);
    const res = rep.results[0];
    expect(res.engine).toBe("bugs");
    expect(res.status).toBe("failed");
    const rules = new Set((res.findings as Array<{ ruleId: string }>).map((f) => f.ruleId));
    for (const rule of ["bugs/bola", "bugs/race-lost-update"])
      expect(rules, [...rules].join(",")).toContain(rule);
    const bola = (res.findings as Array<{ ruleId: string; fingerprint: string }>).find(
      (f) => f.ruleId === "bugs/bola",
    );
    bolaFp = bola?.fingerprint ?? "";
    // artifacts renamed to <runId>
    const runDir = join(dir, ".second-world", "artifacts", res.runId);
    expect(existsSync(runDir)).toBe(true);
    expect(readdirSync(runDir)).toContain(`bugs-${bolaFp}.json`);
    expect(res.limitations.map((l: { code: string }) => l.code)).not.toContain("BUGS_MUTATIONS_BLOCKED");
  }, 200_000);

  it("sw replay <prefix> reproduces the recorded finding (exit 1)", async () => {
    expect(bolaFp).not.toBe("");
    const r = await runCli(["--yes", "replay", bolaFp.slice(0, 10), "--runs", "3", "--json"], {
      cwd: dir,
      env,
      timeoutMs: 120_000,
    });
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({
      fingerprint: bolaFp,
      ruleId: "bugs/bola",
      classification: "reproduced-defect",
    });
    expect(j.runs).toBeGreaterThanOrEqual(3);
    expect(typeof j.wilson.lower).toBe("number");
    const missing = await runCli(["replay", "ffffffffffff"], { cwd: dir, env });
    expect(missing.exitCode).toBe(2);
  }, 150_000);

  it("without approval mutations are blocked (limitation BUGS_MUTATIONS_BLOCKED)", async () => {
    const r = await runCli(["-f", "json", "bugs", "--techniques", "contract", "--json", "--no-history"], {
      cwd: dir,
      env,
      timeoutMs: 120_000,
    });
    expect([0, 1]).toContain(r.exitCode);
    const res = JSON.parse(r.stdout).results[0];
    expect(res.limitations.map((l: { code: string }) => l.code)).toContain("BUGS_MUTATIONS_BLOCKED");
    expect(res.data.mutationsAllowed).toBe(false);
  }, 150_000);
});

describe("relocateArtifacts (pending dir renamed to the runId)", () => {
  it("rewrites result.artifacts, reproduction.artifacts and evidence[].artifact; leaves other paths", () => {
    const from = join("root", "pending-X");
    const to = join("root", "RUN");
    const json = join(from, "bugs-ab.json");
    const har = join(from, "bugs-ab", "reproduction.har");
    const result = {
      artifacts: [
        { name: "bugs-ab", path: json, mediaType: "application/json" },
        { name: "other", path: join("root", "pending-XY", "f.json"), mediaType: "application/json" },
      ],
      findings: [
        {
          reproduction: { steps: [], artifacts: [json, har] },
          evidence: [
            {
              kind: "http-exchange",
              requestHash: "ab",
              method: "GET",
              url: "u",
              status: 500,
              artifact: json,
            },
            { kind: "note", text: "x" },
          ],
        },
      ],
    } as unknown as EngineResult;
    relocateArtifacts(result, from, to);
    expect(result.artifacts.map((a) => a.path)).toEqual([
      join(to, "bugs-ab.json"),
      join("root", "pending-XY", "f.json"),
    ]);
    const f = result.findings[0] as unknown as {
      reproduction: { artifacts: string[] };
      evidence: { artifact?: string }[];
    };
    expect(f.reproduction.artifacts).toEqual([
      join(to, "bugs-ab.json"),
      join(to, "bugs-ab", "reproduction.har"),
    ]);
    expect(f.evidence[0]?.artifact).toBe(join(to, "bugs-ab.json"));
    expect(f.evidence[1]).toEqual({ kind: "note", text: "x" });
  });
});
