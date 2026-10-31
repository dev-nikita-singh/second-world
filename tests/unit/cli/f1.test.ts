/**
 * F1 wiring: sw inspect / stress / history / init (flag mapping in-process, commands via subprocess).
 * Every subprocess runs in a temp cwd with a temp user-config dir; inspect uses a temp --cache-dir,
 * so nothing is written into examples/ or the repo.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectProject, ensureGitignore, renderConfig } from "../../../src/cli/commands/init.js";
import { inspectInputFromFlags, parseRuleFlags } from "../../../src/cli/commands/inspect.js";
import { stressInputFromFlags } from "../../../src/cli/commands/stress.js";
import {
  type ChildCalibratedServer,
  startCalibratedServerInChild,
} from "../../fixtures/servers/calibrated-child.js";
import { REPO_ROOT, runCli } from "../../helpers/cli.js";

function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "sw-f1-"));
  mkdirSync(join(dir, ".git"));
  for (const [n, c] of Object.entries(files)) {
    mkdirSync(join(dir, n, ".."), { recursive: true });
    writeFileSync(join(dir, n), c);
  }
  return dir;
}

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

describe("flag mapping", () => {
  it("stress: steps, hold, settle, thresholds; perf flags pass through", () => {
    expect(
      stressInputFromFlags("http://127.0.0.1:1/", {
        steps: "10, 25,50",
        hold: "5s",
        settle: "1s",
        threshold: ["p95<300ms"],
        timeout: "2s",
        model: "open",
      }),
    ).toEqual({
      target: "http://127.0.0.1:1/",
      stages: [10, 25, 50],
      hold: "5s",
      settle: "1s",
      timeout: "2s",
      thresholds: { http: ["p95<300ms"] },
    });
    expect(() => stressInputFromFlags(undefined, { steps: "10,x" })).toThrow(/--steps/);
  });
  it("stress: breakpoint flags → breakpoint + loadType rate + mode", () => {
    expect(
      stressInputFromFlags(undefined, { rateFrom: "50", rateTo: "400/s", step: "50", minStep: "10" }),
    ).toEqual({
      breakpoint: { from: 50, to: 400, step: 50, minStep: 10 },
      loadType: "rate",
      mode: "breakpoint",
    });
    expect(() => stressInputFromFlags(undefined, { rateFrom: "50" })).toThrow(/rate-to/);
  });
  it("stress: soak --rate R --duration D → soak {level, duration}", () => {
    expect(stressInputFromFlags(undefined, { mode: "soak", rate: "20", duration: "10m" })).toEqual({
      mode: "soak",
      soak: { level: 20, duration: "10m" },
      loadType: "rate",
    });
  });
  it("inspect: --rule, --no-cache, --cache-dir, --tsconfig", () => {
    expect(parseRuleFlags(["arch004=off", "ARCH001=warn"])).toEqual({ ARCH004: "off", ARCH001: "warn" });
    expect(() => parseRuleFlags(["ARCH004"])).toThrow(/--rule/);
    expect(() => parseRuleFlags(["ARCH004=loud"])).toThrow(/--rule/);
    expect(
      inspectInputFromFlags("app", {
        rule: ["ARCH004=off"],
        cache: false,
        cacheDir: "/c",
        tsconfig: "tsconfig.app.json",
      }),
    ).toEqual({
      project: "app",
      rules: { ARCH004: "off" },
      noCache: true,
      cacheDir: "/c",
      tsconfig: "tsconfig.app.json",
    });
  });
  it("init: detection + rendered config + gitignore", () => {
    const dir = project({
      "package.json": JSON.stringify({
        name: "svc",
        scripts: { start: "node ." },
        dependencies: { express: "5", hono: "4" },
      }),
      "pnpm-lock.yaml": "",
      "docs/openapi.yaml": "openapi: 3.1.0",
      "tsconfig.json": "{}",
      ".gitignore": "node_modules",
    });
    const d = detectProject(dir);
    expect(d).toMatchObject({
      name: "svc",
      packageManager: "pnpm",
      frameworks: ["express", "hono"],
      openapi: "docs/openapi.yaml",
      startScript: "start",
      tsconfig: "tsconfig.json",
    });
    const text = renderConfig(d, { targetUrl: "http://127.0.0.1:4000", healthPath: "/health" });
    expect(text).toContain('"http://127.0.0.1:4000"');
    expect(text).toContain('["pnpm", "run", "start"]');
    expect(text).toContain("allowPublic: false");
    expect(ensureGitignore(dir)).toBe(true);
    expect(ensureGitignore(dir)).toBe(false);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      "node_modules\n# SECOND WORLD artifacts (reports, history, cache, audit log)\n.second-world/\n",
    );
    expect(detectProject(mkdtempSync(join(tmpdir(), "sw-empty-")))).toMatchObject({
      packageManager: "npm",
      frameworks: [],
    });
  });
});

describe("sw inspect (subprocess)", () => {
  it("finds ARCH findings in examples/shop-express, exit 1 (error-level rules), graph output", async () => {
    const dir = project();
    const cache = mkdtempSync(join(tmpdir(), "sw-archcache-"));
    const app = join(REPO_ROOT, "examples", "shop-express");
    const r = await runCli(["inspect", app, "--cache-dir", cache, "--json", "--no-history"], {
      cwd: dir,
      env,
      timeoutMs: 120_000,
    });
    expect(r.exitCode).toBe(1);
    const rep = JSON.parse(r.stdout);
    const findings = rep.results[0].findings as Array<{ ruleId: string }>;
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => /^ARCH\d{3}$/.test(f.ruleId))).toBe(true);
    expect(existsSync(join(app, ".second-world"))).toBe(false);

    const g = await runCli(
      ["inspect", app, "--cache-dir", cache, "--graph", "mermaid", "--no-history", "-f", "tty"],
      { cwd: dir, env, timeoutMs: 120_000 },
    );
    expect(g.stdout).toMatch(/^(graph|flowchart)/m);
    // turning the error-level rules off → passes
    const off = await runCli(
      [
        "inspect",
        app,
        "--cache-dir",
        cache,
        "--no-history",
        "-f",
        "json",
        "--json",
        "--rule",
        "ARCH001=off",
        "--rule",
        "ARCH002=off",
        "--rule",
        "ARCH007=off",
        "--rule",
        "ARCH010=off",
      ],
      { cwd: dir, env, timeoutMs: 120_000 },
    );
    expect(JSON.parse(off.stdout).results[0].status).toBe("passed");
  });
});

describe("sw stress + history (subprocess, calibrated server in a child process)", () => {
  let srv: ChildCalibratedServer;
  const dir = project();
  beforeAll(async () => {
    srv = await startCalibratedServerInChild();
  }, 30_000);
  afterAll(async () => {
    await srv?.close();
  });

  it("short step run → result, history auto-saved; list / diff / baseline / verify / prune round trip", async () => {
    const target = `${srv.url}/fixed/5`;
    const args = [
      "-f",
      "json",
      "stress",
      target,
      "--steps",
      "2,4",
      "--hold",
      "1s",
      "--threshold",
      "p95<2s",
      "--json",
    ];
    const r1 = await runCli(args, { cwd: dir, env, timeoutMs: 120_000 });
    expect(r1.exitCode, r1.stderr).toBe(0);
    const rep = JSON.parse(r1.stdout);
    expect(rep.results[0].engine).toBe("stress");
    expect(rep.results[0].data.stages).toHaveLength(2);
    const r2 = await runCli(args, { cwd: dir, env, timeoutMs: 120_000 });
    expect(r2.exitCode).toBe(0);

    const list = await runCli(["history", "list", "--json"], { cwd: dir, env });
    expect(list.exitCode).toBe(0);
    const entries = JSON.parse(list.stdout) as Array<{ id: string; label: string }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.label).toBe("stress");
    const [newer, older] = entries.map((e) => e.id) as [string, string];

    const base = await runCli(["history", "baseline", "set", "main", older], { cwd: dir, env });
    expect(base.exitCode).toBe(0);
    const diff = await runCli(["history", "diff", "baseline:main", newer.slice(0, 10), "--json"], {
      cwd: dir,
      env,
    });
    expect([0, 1]).toContain(diff.exitCode);
    const cmp = JSON.parse(diff.stdout);
    expect(cmp.baselineIds).toEqual([older]);
    expect(cmp.currentIds).toEqual([newer]);

    const md = await runCli(["history", "diff", older, newer, "--format", "md"], { cwd: dir, env });
    expect([0, 1]).toContain(md.exitCode);
    expect(md.stdout).toMatch(/\|/); // markdown table
    const tty = await runCli(["history", "diff", older, newer], { cwd: dir, env });
    expect([0, 1]).toContain(tty.exitCode);
    expect(tty.stdout.length).toBeGreaterThan(0);

    const show = await runCli(["history", "show", newer], { cwd: dir, env });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain(newer);
    expect((await runCli(["history", "show", "ZZZZZZZZ"], { cwd: dir, env })).exitCode).toBe(2);

    const verify = await runCli(["history", "verify", "--json"], { cwd: dir, env });
    expect(verify.exitCode).toBe(0);
    expect(JSON.parse(verify.stdout).ok).toBe(true);

    const trend = await runCli(["history", "trend", "--metric", "p95", "--json"], { cwd: dir, env });
    expect(trend.exitCode).toBe(0);

    const prune = await runCli(["history", "prune", "--keep", "1", "--dry-run", "--json"], { cwd: dir, env });
    expect(prune.exitCode).toBe(0);
    // the older run is the "main" baseline, which prune always keeps
    expect(JSON.parse(prune.stdout)).toMatchObject({ dryRun: true, kept: 2, removed: [] });
    expect(JSON.parse((await runCli(["history", "list", "--json"], { cwd: dir, env })).stdout)).toHaveLength(
      2,
    );
  }, 240_000);

  it("verify exits 1 when a stored report is corrupted", async () => {
    const d = project({ "sw.config.json": JSON.stringify({ history: { dir: "hist" } }) });
    const r = await runCli(
      ["-f", "json", "stress", `${srv.url}/fixed/1`, "--steps", "1", "--hold", "500ms", "--json"],
      { cwd: d, env, timeoutMs: 120_000 },
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const idx = readFileSync(join(d, "hist", "runs.jsonl"), "utf8")
      .trim()
      .split("\n");
    const entry = JSON.parse(idx[idx.length - 1] as string) as { file: string };
    writeFileSync(join(d, "hist", entry.file), "garbage");
    const v = await runCli(["history", "verify"], { cwd: d, env });
    expect(v.exitCode).toBe(1);
  }, 120_000);

  it("--no-history and history.enabled: false skip saving", async () => {
    const d = project({ "sw.config.json": JSON.stringify({ history: { enabled: false } }) });
    const r = await runCli(
      ["-f", "json", "perf", `${srv.url}/fixed/1`, "--iterations", "5", "--vus", "1", "--json"],
      { cwd: d, env },
    );
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(d, ".second-world", "history"))).toBe(false);
  }, 60_000);

  it("-f sarif,html writes report.sarif and report.html", async () => {
    const d = project();
    const r = await runCli(
      ["-f", "sarif,html", "perf", `${srv.url}/fixed/1`, "--iterations", "5", "--vus", "1", "--no-history"],
      { cwd: d, env },
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/not supported/);
    const sarif = JSON.parse(readFileSync(join(d, ".second-world", "reports", "report.sarif"), "utf8"));
    expect(sarif.version).toBe("2.1.0");
    expect(readFileSync(join(d, ".second-world", "reports", "report.html"), "utf8")).toMatch(/<html/i);
  }, 60_000);
});

describe("sw init (subprocess)", () => {
  it("--yes writes sw.config.ts that loads and validates; refuses to overwrite without --force", async () => {
    const dir = project({
      "package.json": JSON.stringify({
        name: "demo",
        scripts: { start: "node server.js" },
        dependencies: { fastify: "5" },
      }),
    });
    const r = await runCli(["--yes", "init"], { cwd: dir, env });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(existsSync(join(dir, "sw.config.ts"))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".second-world/");
    const v = await runCli(["config", "validate", "--json"], { cwd: dir, env });
    expect(v.exitCode, v.stdout + v.stderr).toBe(0);
    const again = await runCli(["--yes", "init"], { cwd: dir, env });
    expect(again.exitCode).toBe(2);
    expect(again.stderr).toMatch(/--force/);
    expect((await runCli(["--yes", "init", "--force"], { cwd: dir, env })).exitCode).toBe(0);
  }, 60_000);
});
