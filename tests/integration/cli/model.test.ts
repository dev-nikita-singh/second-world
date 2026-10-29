/**
 * `sw model build|show|diff` end to end on examples/shop-express with sw-model's fixture traces and
 * config files (owner: sw-core). The CLI runs in a temp cwd with a temp --cache-dir: nothing is
 * written into examples/.
 */
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modelInputFromFlags } from "../../../src/cli/commands/model.js";
import { REPO_ROOT, runCli } from "../../helpers/cli.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };
const PROJECT = join(REPO_ROOT, "examples", "shop-express");
const FIX = join(REPO_ROOT, "tests", "fixtures", "model");

describe("modelInputFromFlags", () => {
  it("maps sources and the architecture cache", () => {
    expect(
      modelInputFromFlags(
        "app",
        {
          openapi: "api.yaml",
          configFile: ["compose.yml"],
          traces: ["t.json"],
          prometheus: ["http://127.0.0.1:9090/metrics", "m.txt"],
          serviceName: "shop",
          detail: "full",
          cacheDir: "c",
          cache: false,
        },
        "/w",
      ),
    ).toMatchObject({
      project: "app",
      serviceName: "shop",
      detail: "full",
      prometheus: [{ url: "http://127.0.0.1:9090/metrics" }, expect.stringMatching(/m\.txt$/)],
      architecture: { noCache: true, cacheDir: expect.stringMatching(/c$/) },
    });
    expect(modelInputFromFlags(undefined, { architecture: false }, "/w")).toEqual({ architecture: false });
  });
});

describe("sw model (subprocess)", () => {
  it("build (code + contract + config + traces) → snapshot + history; show --graph mermaid; diff of two builds", async () => {
    const hadDotDir = existsSync(join(PROJECT, ".second-world"));
    const dir = mkdtempSync(join(tmpdir(), "sw-model-cli-"));
    mkdirSync(join(dir, ".git"));
    const cache = mkdtempSync(join(tmpdir(), "sw-model-cache-"));
    const common = [
      "model",
      "build",
      PROJECT,
      "--openapi",
      join(PROJECT, "openapi.yaml"),
      "--config-file",
      join(FIX, "shop-config", "docker-compose.yml"),
      "--cache-dir",
      cache,
    ];

    const full = await runCli([...common, "--traces", join(FIX, "shop-traces.json"), "--traces", join(FIX, "payments-traces.jsonl"), "--json"], {
      cwd: dir,
      env,
      timeoutMs: 120_000,
    });
    expect(full.exitCode, full.stderr.slice(-2000)).toBe(0);
    const model = JSON.parse(full.stdout);
    expect(model.schemaVersion).toBe(1);
    expect(model.nodes.map((n: { id: string }) => n.id)).toContain("service:payments-fake");
    expect(model.coverage.runtimeObserved).toBeTruthy();
    const snapA = /snapshot: (.+)$/m.exec(full.stderr)?.[1]?.trim() as string;
    expect(existsSync(snapA)).toBe(true);
    expect(existsSync(join(dir, ".second-world", "model", "latest.json"))).toBe(true);
    const hist = await runCli(["history", "list", "--json"], { cwd: dir, env });
    expect(JSON.parse(hist.stdout)[0]).toMatchObject({ label: "model" });

    const show = await runCli(["model", "show", "--graph", "mermaid"], { cwd: dir, env });
    expect(show.exitCode, show.stderr).toBe(0);
    expect(show.stdout).toMatch(/^(graph|flowchart)/m);
    const node = await runCli(["model", "show", "--node", "service:payments-fake"], { cwd: dir, env });
    expect(node.exitCode, node.stderr).toBe(0);
    expect(JSON.parse(node.stdout).node).toBe("service:payments-fake");

    // second build without runtime traces → observed metrics / trace evidence disappear
    const staticOnly = await runCli([...common, "--no-history", "--graph", "json"], { cwd: dir, env, timeoutMs: 120_000 });
    expect(staticOnly.exitCode, staticOnly.stderr.slice(-2000)).toBe(0);
    const snapB = /snapshot: (.+)$/m.exec(staticOnly.stderr)?.[1]?.trim() as string;
    expect(snapB).not.toBe(snapA);

    const diff = await runCli(["model", "diff", snapA, snapB, "--json"], { cwd: dir, env });
    expect(diff.exitCode, diff.stderr).toBe(0);
    const d = JSON.parse(diff.stdout);
    expect(d.summary.added + d.summary.removed + d.summary.changed).toBeGreaterThan(0);
    const text = await runCli(["model", "diff", snapA, "latest"], { cwd: dir, env });
    expect(text.stdout).toMatch(/model diff:/);

    expect(existsSync(join(PROJECT, ".second-world"))).toBe(hadDotDir);
  }, 240_000);

  it("show without a snapshot → exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-model-empty-"));
    mkdirSync(join(dir, ".git"));
    expect((await runCli(["model", "show"], { cwd: dir, env })).exitCode).toBe(2);
  });
});
