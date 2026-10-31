/**
 * Coverage tests for engine-input builders and auth/secret resolution in src/core/world.ts
 * (docs/08-configuration.md §3 auth roles, F10 route auth). Owner: sw-coverage (Wave 5).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/core/config/loader.js";
import { ConfigError } from "../../../src/core/errors.js";
import {
  authHeadersFor,
  buildAgentInput,
  buildArchitectureInput,
  buildBugsInput,
  buildEvolutionInput,
  buildModelInput,
  buildPerformanceInput,
  buildReliabilityInput,
  buildStressInput,
  buildWhatIfInput,
} from "../../../src/core/world.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function cfgOf(inline: Record<string, unknown>) {
  const d = mkdtempSync(join(tmpdir(), "sw-world-cov-"));
  dirs.push(d);
  const r = await loadConfig({ cwd: d, inline, userConfig: false, env: {} });
  return { cfg: r, dir: d };
}

const AUTH = {
  admin: { type: "bearer", token: { env: "ADMIN_TOKEN" } },
  basic: { type: "basic", username: "u", password: { env: "PW" } },
  key: { type: "header", name: "X-Api-Key", value: { file: "key.txt" } },
  oauth: { type: "oauth2", clientId: "x" },
  broken: { type: "bearer" },
};

describe("authHeadersFor", () => {
  it("bearer / basic / header roles resolve secrets from env and files", async () => {
    const { cfg, dir } = await cfgOf({ auth: AUTH });
    writeFileSync(join(dir, "key.txt"), "file-key-123\n");
    const env = { ADMIN_TOKEN: "tok-abc", PW: "p@ss" };
    expect(authHeadersFor(cfg, "admin", env)).toEqual({ authorization: "Bearer tok-abc" });
    expect(authHeadersFor(cfg, "basic", env)).toEqual({
      authorization: `Basic ${Buffer.from("u:p@ss").toString("base64")}`,
    });
    expect(authHeadersFor(cfg, "key", env)).toEqual({ "x-api-key": "file-key-123" });
  });

  it("unknown, unsupported, incomplete roles and missing secrets → undefined (never throws)", async () => {
    const { cfg } = await cfgOf({ auth: AUTH });
    expect(authHeadersFor(cfg, "nope", {})).toBeUndefined();
    expect(authHeadersFor(cfg, "oauth", {})).toBeUndefined();
    expect(authHeadersFor(cfg, "broken", {})).toBeUndefined();
    expect(authHeadersFor(cfg, "admin", {})).toBeUndefined();
    expect(authHeadersFor(cfg, "key", {})).toBeUndefined();
    const { cfg: none } = await cfgOf({});
    expect(authHeadersFor(none, "admin", {})).toBeUndefined();
  });
});

describe("performance / stress inputs", () => {
  it("resolves target names, rate/duration strings, numeric strings, auth roles and defaults", async () => {
    const { cfg } = await cfgOf({
      targets: {
        db: { url: "http://127.0.0.1:5432", role: "dependency" },
        api: { url: "http://127.0.0.1:3000" },
      },
      auth: AUTH,
      performance: {
        rate: "100/s",
        duration: "2s",
        warmup: "500",
        auth: "admin",
        scenarios: [{ name: "a", auth: "basic" }, { name: "b" }, 3],
      },
    });
    const p = buildPerformanceInput(cfg, {}, { seed: 9, env: { ADMIN_TOKEN: "t1", PW: "p1" } });
    expect(p.target).toBe("http://127.0.0.1:3000");
    expect(p.rate).toBe(100);
    expect(p.duration).toBe(2000);
    expect(p.warmup).toBe(500);
    expect(p.auth).toMatchObject({ type: "bearer", token: "t1" });
    expect((p.scenarios as any[])[0].auth).toMatchObject({ password: "p1" });
    expect((p.scenarios as any[])[2]).toBe(3);
    expect(p.seed).toBe(9);
    expect(p.allowHosts).toEqual(cfg.config.safety.allowHosts);
    const named = buildPerformanceInput(
      cfg,
      { target: "db", seed: 1 },
      { seed: 9, env: { ADMIN_TOKEN: "t", PW: "p" } },
    );
    expect(named.target).toBe("http://127.0.0.1:5432");
    expect(named.seed).toBe(1);
  });

  it("undefined auth role → SW_CONFIG_AUTH naming the location; missing secret → SW_CONFIG_SECRET", async () => {
    const { cfg } = await cfgOf({ auth: AUTH, performance: { scenarios: [{ auth: "ghost" }] } });
    expect(() => buildPerformanceInput(cfg, {}, { env: {} })).toThrow(
      /performance\.scenarios\.0\.auth "ghost"/,
    );
    const { cfg: c2 } = await cfgOf({ auth: AUTH, stress: { auth: "admin" } });
    try {
      buildStressInput(c2, {}, { env: {} });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe("SW_CONFIG_SECRET");
    }
  });

  it("stress inherits perf base keys; stress overrides; rate units parsed", async () => {
    const { cfg } = await cfgOf({
      targets: { api: { url: "http://127.0.0.1:3000" } },
      performance: { target: "api", thresholds: { p95: "100ms" }, rate: 5 },
      stress: { rate: "50/s" },
    });
    const s = buildStressInput(cfg, {}, { seed: 3 });
    expect(s.target).toBe("http://127.0.0.1:3000");
    expect(s.thresholds).toEqual({ p95: "100ms" });
    expect(s.rate).toBe(50);
    expect(s.seed).toBe(3);
    const { cfg: c2 } = await cfgOf({ targets: { api: { url: "http://127.0.0.1:1" } } });
    expect(buildStressInput(c2).target).toBe("http://127.0.0.1:1");
  });
});

describe("other builders", () => {
  it("architecture/model resolve paths against the config dir; model picks bugs.contract", async () => {
    const { cfg } = await cfgOf({
      project: { root: "app", name: "svc" },
      bugs: { contract: "api.yaml" },
      architecture: { tsconfig: "tsconfig.app.json" },
    });
    const a = buildArchitectureInput(cfg);
    expect(a.project).toBe(resolve(cfg.cwd, "app"));
    expect(a.tsconfig).toBe(resolve(cfg.cwd, "app", "tsconfig.app.json"));
    expect(String(a.cacheDir)).toContain(join(".second-world", "cache", "arch"));
    const m = buildModelInput(cfg);
    expect(m.openapi).toBe(resolve(cfg.cwd, "api.yaml"));
    expect(m.serviceName).toBe("svc");
    const m2 = buildModelInput(cfg, { openapi: "other.yaml", cacheDir: "c", project: "p" });
    expect(m2.openapi).toBe(resolve(cfg.cwd, "other.yaml"));
    expect(m2.cacheDir).toBe(resolve(cfg.cwd, "c"));
  });

  it("whatif and evolution defaults", async () => {
    const { cfg } = await cfgOf({
      performance: { target: "http://127.0.0.1:1", rate: 5 },
      evolution: { repo: "sub" },
    });
    expect(buildWhatIfInput(cfg, { name: "x" })).toEqual({ name: "x", cwd: cfg.cwd });
    expect(buildWhatIfInput(cfg, { cwd: "/elsewhere" }).cwd).toBe("/elsewhere");
    const e = buildEvolutionInput(cfg);
    expect(e.repo).toBe(resolve(cfg.cwd, "sub"));
    expect(e.workload).toEqual({ rate: 5 });
  });

  it("reliability: dependency shorthands, injector defaults, route auth with explicit headers winning", async () => {
    const { cfg } = await cfgOf({
      environment: "staging",
      targets: {
        api: { url: "http://127.0.0.1:3000" },
        pay: { url: "http://127.0.0.1:4000", role: "dependency" },
      },
      auth: AUTH,
      reliability: {
        injector: "toxiproxy",
        dependencies: { pay: { upstream: "pay", proxyListen: 0 }, other: { injector: "auto" }, bad: 5 },
        workload: {
          routes: [
            { path: "/a", auth: "admin" },
            { path: "/b", auth: "admin", headers: { Authorization: "Bearer explicit" } },
            { path: "/c", auth: "ghost" },
            "/d",
          ],
        },
      },
    });
    const r = buildReliabilityInput(cfg, {}, { seed: 4, env: { ADMIN_TOKEN: "tk" } });
    expect(r.target).toBe("http://127.0.0.1:3000");
    expect(r.environment).toBe("staging");
    expect(r.seed).toBe(4);
    const deps = r.dependencies as Record<string, any>;
    expect(deps.pay).toEqual({ upstream: "http://127.0.0.1:4000", listen: 0, injector: "toxiproxy" });
    expect(deps.other.injector).toBe("toxiproxy");
    expect(deps.bad).toBeUndefined();
    const routes = (r.workload as any).routes;
    expect(routes[0]).toEqual({ path: "/a", headers: { authorization: "Bearer tk" } });
    expect(routes[1].headers).toEqual({ Authorization: "Bearer explicit" });
    expect(routes[2]).toEqual({ path: "/c", auth: "ghost" });
    expect(routes[3]).toBe("/d");
  });

  it("bugs: contract→openapi, roles from config.auth (supported types only), explicit roles, hooks", async () => {
    const { cfg, dir } = await cfgOf({
      targets: { api: { url: "http://127.0.0.1:3000" } },
      auth: { admin: AUTH.admin, oauth: AUTH.oauth },
      bugs: { contract: "openapi.yaml" },
      hooks: {
        reset: { command: "npm run reset", cwd: "x", timeout: 5 },
        setup: { http: { url: "http://127.0.0.1:3000/setup" } },
        other: { command: "y" },
      },
    });
    const b = buildBugsInput(cfg, {}, { seed: 2, env: { ADMIN_TOKEN: "t" } });
    expect(b.openapi).toBe("openapi.yaml");
    expect(b.cwd).toBe(dir);
    expect(b.target).toBe("http://127.0.0.1:3000");
    expect((b.auth as any).roles).toEqual({ admin: { type: "bearer", token: "t" } });
    expect((b.hooks as any).reset).toEqual({ command: "npm run reset", cwd: "x", timeout: 5 });
    expect((b.hooks as any).setup).toEqual({ http: { url: "http://127.0.0.1:3000/setup" } });
    const b2 = buildBugsInput(
      cfg,
      {
        contract: "c.yaml",
        target: "api",
        auth: { roles: { r: { type: "bearer", token: { env: "R" } }, s: "raw" } },
      },
      { env: { R: "rt", ADMIN_TOKEN: "t" } },
    );
    expect(b2.openapi).toBe("openapi.yaml"); // section contract wins
    expect((b2.auth as any).roles).toEqual({ r: { type: "bearer", token: "rt" }, s: "raw" });
    expect(() => buildBugsInput(cfg, {}, { env: {} })).toThrow(/ADMIN_TOKEN/);
  });

  it("agent: inherits bugs base, agent.contract → openapi, agent roles resolved", async () => {
    const { cfg } = await cfgOf({
      targets: { api: { url: "http://127.0.0.1:3000" } },
      agent: {
        contract: "agent.yaml",
        target: "api",
        auth: { roles: { x: { type: "bearer", token: { env: "X" } }, y: "plain" } },
      },
    });
    const a = buildAgentInput(cfg, {}, { seed: 1, env: { X: "xv" } });
    expect(a.openapi).toBe("agent.yaml");
    expect(a.target).toBe("http://127.0.0.1:3000");
    expect((a.auth as any).roles).toEqual({ x: { type: "bearer", token: "xv" }, y: "plain" });
    expect(a.seed).toBe(1);
  });
});
