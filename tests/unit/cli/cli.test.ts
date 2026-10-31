import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { perfInputFromFlags } from "../../../src/cli/commands/perf.js";
import { buildProgram } from "../../../src/cli/main.js";
import { runCli, spawnCli } from "../../helpers/cli.js";

function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "sw-cli-"));
  mkdirSync(join(dir, ".git"));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  return dir;
}

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

describe("program definition (in-process)", () => {
  it("has the expected commands and global flags", () => {
    const p = buildProgram();
    expect(p.commands.map((c) => c.name())).toEqual([
      "doctor",
      "config",
      "perf",
      "stress",
      "inspect",
      "bugs",
      "agent",
      "replay",
      "reliability",
      "whatif",
      "evolve",
      "model",
      "analyze",
      "history",
      "init",
    ]);
    const flags = p.options.map((o) => o.long);
    for (const f of [
      "--config",
      "--profile",
      "--set",
      "--format",
      "--out",
      "--fail-on",
      "--seed",
      "--yes",
      "--dry-run",
      "--no-config-code",
      "--json-logs",
    ]) {
      expect(flags).toContain(f);
    }
  });
  it("perfInputFromFlags maps flags", () => {
    expect(
      perfInputFromFlags("http://127.0.0.1:1/x", {
        rate: "200",
        duration: "5s",
        vus: "3",
        threshold: ["p95<300ms"],
      }),
    ).toEqual({
      target: "http://127.0.0.1:1/x",
      rate: 200,
      duration: "5s",
      vus: 3,
      thresholds: { http: ["p95<300ms"] },
    });
    expect(() => perfInputFromFlags(undefined, { vus: "-1" })).toThrow(/positive integer/);
  });
});

describe("sw CLI (subprocess)", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((_q, r) => r.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("--help exits 0 quickly", async () => {
    const r = await runCli(["--help"], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("doctor");
  });

  it("doctor --json prints an EnvironmentReport and exits 0", async () => {
    const r = await runCli(["doctor", "--json", "--quick"], { env });
    expect(r.exitCode).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.runtime.name).toBe("node");
    expect(j.os.platform).toBe(process.platform);
    expect(typeof j.resources.cpus).toBe("number");
    expect(j.capabilities).toBeTypeOf("object");
    expect(Array.isArray(j.checks)).toBe(true);
    expect(r.stderr).not.toMatch(/ExperimentalWarning/);
  });

  it("invalid config → exit 2 with key path", async () => {
    const dir = project({ "sw.config.json": JSON.stringify({ safety: { maxRps: "fast" } }) });
    const r = await runCli(["config", "validate"], { cwd: dir, env });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/safety\.maxRps/);
    expect(r.stderr).toMatch(/hint:/);
  });

  it("config validate / print --resolved --json", async () => {
    const dir = project({
      "sw.config.yaml": "environment: staging\nprofiles:\n  ci: { report: { failOn: never } }\n",
    });
    const v = await runCli(["config", "validate", "--json"], { cwd: dir, env });
    expect(v.exitCode).toBe(0);
    expect(JSON.parse(v.stdout).valid).toBe(true);
    const p = await runCli(
      ["config", "print", "--resolved", "--json", "-p", "ci", "--set", "safety.maxRps=10"],
      { cwd: dir, env },
    );
    expect(p.exitCode).toBe(0);
    const j = JSON.parse(p.stdout);
    expect(j.config.environment).toBe("staging");
    expect(j.config.report.failOn).toBe("never");
    expect(j.origins["safety.maxRps"]).toBe("--set");
    expect(j.origins["report.failOn"]).toBe("profile ci");
  });

  it("config validate checks engine sections (performance) → exit 2", async () => {
    for (const perf of [
      { rate: "not-a-rate" },
      { model: "warp" },
      { thresholds: { "http.p95": "< banana" } },
    ]) {
      const dir = project({ "sw.config.json": JSON.stringify({ performance: perf }) });
      const r = await runCli(["config", "validate"], { cwd: dir, env });
      expect(r.exitCode, JSON.stringify(perf)).toBe(2);
    }
    const ok = project({
      "sw.config.json": JSON.stringify({ performance: { rate: "100/s", duration: "5s" } }),
    });
    expect((await runCli(["config", "validate"], { cwd: ok, env })).exitCode).toBe(0);
  });

  it("--no-config-code refuses TS configs (exit 2)", async () => {
    const dir = project({ "sw.config.ts": "export default {}" });
    const r = await runCli(["--no-config-code", "config", "validate"], { cwd: dir, env });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/no-config-code/);
  });

  it("public target → exit 3", async () => {
    const dir = project();
    const r = await runCli(["perf", "https://example.com/", "--iterations", "1"], { cwd: dir, env });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toMatch(/SW_SAFETY_PUBLIC_TARGET/);
  });

  it("unknown option → exit 2; missing target → exit 2", async () => {
    expect((await runCli(["perf", "--bogus"], { env })).exitCode).toBe(2);
    const dir = project();
    const r = await runCli(["perf"], { cwd: dir, env });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/No performance target/);
  });

  it("perf --dry-run sends nothing and prints the plan", async () => {
    const dir = project();
    const r = await runCli(["--dry-run", "perf", url, "--iterations", "5", "--json"], { cwd: dir, env });
    expect(r.exitCode).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.dryRun).toBe(true);
    expect(j.input.model).toBe("iterations");
  });

  it("perf against a local server → report + exit 0, files written", async () => {
    const dir = project();
    const r = await runCli(
      ["-f", "tty,json,md", "perf", url, "--iterations", "20", "--vus", "2", "--threshold", "p95<5s"],
      {
        cwd: dir,
        env,
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    const files = readdirSync(join(dir, ".second-world", "reports"));
    expect(files).toEqual(expect.arrayContaining(["report.json", "report.md"]));
  });

  it("perf --json prints the combined report; failing threshold → exit 1", async () => {
    const dir = project();
    const r = await runCli(
      ["-f", "tty", "perf", url, "--iterations", "10", "--vus", "1", "--threshold", "p95<0.001ms", "--json"],
      {
        cwd: dir,
        env,
      },
    );
    expect(r.exitCode).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.kind).toBe("second-world-report");
  });

  it("Ctrl+C (SIGINT) → graceful stop, cancelled report, exit 130", async () => {
    if (process.platform === "win32") return; // signals to child processes are not deliverable on Windows
    const dir = project();
    const child = spawnCli(["-f", "tty", "perf", url, "--vus", "2", "--duration", "20s"], { cwd: dir, env });
    await new Promise((r) => setTimeout(r, 2500));
    child.kill("SIGINT");
    const res = await child;
    expect(res.exitCode).toBe(130);
  });
});
