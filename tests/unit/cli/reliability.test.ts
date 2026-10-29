/**
 * `sw reliability` wiring: flag mapping, config mapping and the cheap subprocess paths
 * (list, approval refusal, cleanup). The real fault run lives in tests/integration/cli/reliability.test.ts.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseParams, parseRoutes, reliabilityInputFromFlags } from "../../../src/cli/commands/reliability.js";
import { loadConfig } from "../../../src/core/config/loader.js";
import { buildReliabilityInput } from "../../../src/core/world.js";
import { runCli } from "../../helpers/cli.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config"), SW_FAULT_LEDGER: join(mkdtempSync(join(tmpdir(), "sw-ledger-")), "ledger.json") };

describe("reliability flag / config mapping", () => {
  it("params, routes, phases, hypotheses, abort", () => {
    expect(parseParams(["latencyMs=500", "mode=fixed"])).toEqual({ latencyMs: 500, mode: "fixed" });
    expect(() => parseParams(["oops"])).toThrow(/--param/);
    expect(parseRoutes(["orders=post /orders"])).toEqual([{ name: "orders", method: "POST", path: "/orders" }]);
    expect(() => parseRoutes(["orders"])).toThrow(/--route/);
    expect(
      reliabilityInputFromFlags("dependency-latency", {
        target: "http://127.0.0.1:1",
        dependency: "payments",
        duration: "10s",
        steadyPhase: "3s",
        recovery: "5s",
        steady: ["p95<300ms"],
        hypothesis: ["error_rate<5%"],
        param: ["latencyMs=800"],
        rate: "10",
        route: ["orders=POST /orders"],
        repeat: "2",
        abortErrorRate: "50%",
      }),
    ).toEqual({
      scenario: "dependency-latency",
      target: "http://127.0.0.1:1",
      dependency: "payments",
      duration: "10s",
      steady: "3s",
      recovery: "5s",
      steadyState: ["p95<300ms"],
      hypothesis: ["error_rate<5%"],
      params: { latencyMs: 800 },
      workload: { rate: 10, routes: [{ name: "orders", method: "POST", path: "/orders" }] },
      repeat: 2,
      abort: { errorRate: 0.5 },
    });
  });
  it("buildReliabilityInput: docs/08 shorthand (proxyListen, upstream target name, injector auto), environment", async () => {
    const cfg = await loadConfig({
      env: {},
      userConfig: false,
      inline: {
        environment: "staging",
        targets: { api: { url: "http://127.0.0.1:3000" }, payments: { url: "http://127.0.0.1:4010", role: "dependency" } },
        reliability: { injector: "auto", dependencies: { payments: { proxyListen: 14010, upstream: "payments" } }, steady: "2s" },
      },
    });
    expect(buildReliabilityInput(cfg, { scenario: "dependency-5xx", dependency: "payments" }, { seed: 4 })).toEqual({
      target: "http://127.0.0.1:3000",
      scenario: "dependency-5xx",
      dependency: "payments",
      steady: "2s",
      dependencies: { payments: { injector: "builtin", listen: 14010, upstream: "http://127.0.0.1:4010" } },
      environment: "staging",
      seed: 4,
    });
  });
});

describe("sw reliability (subprocess)", () => {
  function project(cfg: object): string {
    const dir = mkdtempSync(join(tmpdir(), "sw-rel-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "sw.config.json"), JSON.stringify(cfg));
    return dir;
  }

  it("list --json prints the scenario catalogue", async () => {
    const r = await runCli(["reliability", "list", "--json"], { env });
    expect(r.exitCode).toBe(0);
    const list = JSON.parse(r.stdout) as Array<{ id: string; injectors: string[] }>;
    expect(list.map((s) => s.id)).toContain("dependency-latency");
    expect(list.every((s) => Array.isArray(s.injectors))).toBe(true);
  });

  it("run without approval (non-interactive) → SW_SAFETY_APPROVAL_REQUIRED, exit 3", async () => {
    const dir = project({
      targets: { api: { url: "http://127.0.0.1:9" } },
      reliability: { dependencies: { payments: { injector: "builtin", upstream: "http://127.0.0.1:9", listen: 0 } } },
    });
    const r = await runCli(["reliability", "run", "dependency-latency", "--dependency", "payments", "--no-history"], { cwd: dir, env });
    expect(r.exitCode, r.stderr).toBe(3);
    expect(r.stderr).toMatch(/SW_SAFETY_APPROVAL_REQUIRED/);
  });

  it("production without allowProduction is refused (exit 3)", async () => {
    const dir = project({
      environment: "production",
      targets: { api: { url: "http://127.0.0.1:9" } },
      reliability: { dependencies: { payments: { injector: "builtin", upstream: "http://127.0.0.1:9", listen: 0 } } },
    });
    const r = await runCli(["--yes", "reliability", "run", "dependency-latency", "--dependency", "payments", "--no-history"], { cwd: dir, env });
    expect(r.exitCode, r.stderr).toBe(3);
    expect(r.stderr).toMatch(/SW_SAFETY_PRODUCTION/);
  });

  it("cleanup with nothing to clean → exit 0", async () => {
    const r = await runCli(["reliability", "cleanup", "--json"], { env });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ inProcess: 0, ledger: 0, errors: [] });
  });
});
