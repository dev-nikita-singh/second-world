/**
 * `sw whatif` / `sw evolve` wiring: flag mapping, config section, and the fast refusal paths.
 * Real runs live in tests/integration/cli/experiments.test.ts.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyWhatIfFlags, evolveInputFromFlags } from "../../../src/cli/commands/experiments.js";
import { loadConfig } from "../../../src/core/config/loader.js";
import { ConfigSchema } from "../../../src/core/config/schema.js";
import { buildEvolutionInput } from "../../../src/core/world.js";
import { splitCommand } from "../../../src/engines/experiments/index.js";
import { createTempRepo, type TempRepo } from "../../fixtures/experiments/git-repo.js";
import { runCli } from "../../helpers/cli.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

describe("experiments flag / config mapping", () => {
  it("applyWhatIfFlags: design, aa, metrics, seed", () => {
    const def = { name: "x", design: { cooldown: "1s" }, workload: { vus: 1 } };
    expect(
      applyWhatIfFlags(
        def,
        {
          repetitions: "7",
          order: "randomized-blocks",
          lifecycle: "per-arm",
          aa: true,
          metric: ["p95,p99", "rps"],
        },
        9,
      ),
    ).toEqual({
      name: "x",
      workload: { vus: 1 },
      mode: "aa",
      metrics: ["p95", "p99", "rps"],
      design: { cooldown: "1s", repetitions: 7, order: "randomized-blocks", lifecycle: "per-arm", seed: 9 },
    });
    expect(def.design).toEqual({ cooldown: "1s" }); // not mutated
    expect(applyWhatIfFlags({ name: "y" }, {})).toEqual({ name: "y" });
  });

  it("evolveInputFromFlags: candidates, commands split without a shell, sandbox, replays", () => {
    expect(
      evolveInputFromFlags(
        {
          candidates: ["branch:a,commit:abc123", "patch:./c.diff"],
          test: 'npm test -- --grep "fast path"',
          start: "npm run start:test",
          build: "npm run build",
          health: "/healthz",
          repetitions: "5",
          baseline: "HEAD~1",
          finding: "F-1",
          sandbox: "process",
          replay: ["a.json", "b.json"],
          repo: "../app",
        },
        splitCommand,
        "/w/sub",
      ),
    ).toEqual({
      candidates: ["branch:a", "commit:abc123", "patch:./c.diff"],
      test: ["npm", "test", "--", "--grep", "fast path"],
      start: ["npm", "run", "start:test"],
      build: ["npm", "run", "build"],
      health: "/healthz",
      repo: resolve("/w/sub", "../app"),
      baseline: "HEAD~1",
      finding: "F-1",
      design: { repetitions: 5 },
      sandbox: { kind: "process" },
      replays: { artifacts: [resolve("/w/sub", "a.json"), resolve("/w/sub", "b.json")] },
    });
    expect(() => evolveInputFromFlags({ candidates: ["main"] }, splitCommand)).toThrow(/Invalid candidate/);
  });

  it("whatif.experiments config section; evolution workload defaults to the perf section without target", async () => {
    expect(ConfigSchema.safeParse({ whatif: { experiments: { pool: { baseline: {} } } } }).success).toBe(
      true,
    );
    expect(ConfigSchema.safeParse({ whatif: { nope: 1 } }).success).toBe(false);
    const cfg = await loadConfig({
      env: {},
      userConfig: false,
      inline: { performance: { target: "api", vus: 2, duration: "1s" }, evolution: { health: "/healthz" } },
    });
    const built = buildEvolutionInput(cfg, { candidates: ["branch:x"] });
    expect(built).toMatchObject({
      health: "/healthz",
      candidates: ["branch:x"],
      repo: cfg.cwd,
      workload: { vus: 2, duration: "1s" },
    });
    // SECOND WORLD's own state dirs are never counted as working-tree changes (db5ef7d).
    expect(built.ignorePaths).toContain(resolve(cfg.cwd, ".second-world"));
  });
});

describe("sw evolve / sw whatif refusal paths (subprocess)", () => {
  let repo: TempRepo;
  let dir: string;
  beforeAll(async () => {
    repo = await createTempRepo({ dirty: false });
    dir = mkdtempSync(join(tmpdir(), "sw-evo-cli-"));
    mkdirSync(join(dir, ".git"));
  });
  afterAll(async () => {
    await repo?.cleanup();
  });

  it("--sandbox process without --yes → exit 3 (SW_SAFETY_APPROVAL_REQUIRED)", async () => {
    const r = await runCli(
      [
        "evolve",
        "--repo",
        repo.dir,
        "--candidates",
        "branch:fix/fast",
        "--start",
        "node server.mjs",
        "--sandbox",
        "process",
        "--no-history",
      ],
      { cwd: dir, env, timeoutMs: 60_000 },
    );
    expect(r.exitCode, r.stderr).toBe(3);
    expect(r.stderr).toMatch(/SW_SAFETY_APPROVAL_REQUIRED/);
  });

  it("unknown experiment → exit 2 listing defined experiments", async () => {
    writeFileSync(join(dir, "sw.config.json"), JSON.stringify({ whatif: { experiments: { pool: {} } } }));
    const r = await runCli(["whatif", "nope"], { cwd: dir, env });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/pool/);
  });
});
