/**
 * First-run UX (wave 7 §D): what `sw doctor` and `sw init` tell a new user.
 * - doctor: a docker CLI whose daemon is down is a warning, not "✔ docker" (src/core/probe/probe.ts);
 * - doctor: missing config and missing optional `typescript` peer are reported with a fix
 *   (src/core/probe/project.ts);
 * - init: the summary says what was not detected and which default target was written
 *   (src/cli/commands/init.ts initSummary).
 */
import { describe, expect, it } from "vitest";
import { initSummary, type ProjectDetection } from "../../../src/cli/commands/init.js";
import { doctorChecks, probeEnvironment } from "../../../src/core/probe/probe.js";
import { projectChecks } from "../../../src/core/probe/project.js";

/** Fake tool runner: every tool's `--version` works; the docker daemon answers per `daemon`. */
function tools(daemon: string | null) {
  return async (cmd: string, args?: string[]): Promise<string | null> => {
    if (cmd === "docker" && args?.[0] === "version") return daemon;
    if (cmd === "docker") return "Docker version 29.3.0, build abc";
    if (cmd === "git") return "git version 2.51.0";
    return null;
  };
}

describe("doctor: docker daemon", () => {
  it("client present but daemon down → warn with a fix, capability unavailable", async () => {
    const r = await probeEnvironment({ full: true, env: {}, runTool: tools(null) });
    expect(r.tools.docker).toBe("29.3.0");
    expect(r.capabilities.docker).toMatchObject({ available: false });
    expect(r.capabilities.docker?.reason).toMatch(/daemon is not reachable/);
    const c = doctorChecks(r).find((x) => x.id === "tool.docker");
    expect(c).toMatchObject({ status: "warn", label: "docker 29.3.0 (client) — daemon not reachable" });
    expect(c?.fix).toMatch(/docker info/);
  });

  it("daemon answering → ok, capability available", async () => {
    const r = await probeEnvironment({ full: true, env: {}, runTool: tools("29.3.0") });
    expect(r.capabilities.docker).toEqual({ available: true });
    expect(doctorChecks(r).find((x) => x.id === "tool.docker")).toMatchObject({
      status: "ok",
      label: "docker 29.3.0",
    });
  });

  it("no docker CLI → daemon never queried, plain 'not found'", async () => {
    const calls: string[] = [];
    const r = await probeEnvironment({
      full: true,
      env: {},
      runTool: async (cmd, args) => {
        calls.push(`${cmd} ${(args ?? ["--version"]).join(" ")}`);
        return null;
      },
    });
    expect(calls.some((c) => c.startsWith("docker version"))).toBe(false);
    expect(doctorChecks(r).find((x) => x.id === "tool.docker")).toMatchObject({
      status: "warn",
      label: "docker not found",
    });
  });

  it("quick mode probes no tools", async () => {
    let n = 0;
    await probeEnvironment({
      env: {},
      runTool: async () => {
        n++;
        return null;
      },
    });
    expect(n).toBe(0);
  });
});

describe("doctor: project checks", () => {
  const base = { cwd: "/p", typescriptVersion: () => "6.0.3" };

  it("no config found → info pointing at sw init", async () => {
    const c = await projectChecks({ ...base, discoverConfig: () => undefined });
    expect(c.find((x) => x.id === "config")).toMatchObject({ status: "info" });
    expect(c.find((x) => x.id === "config")?.fix).toMatch(/sw init/);
  });

  it("discovered config → ok with its path", async () => {
    const c = await projectChecks({ ...base, discoverConfig: () => "/p/sw.config.ts" });
    expect(c.find((x) => x.id === "config")).toMatchObject({ status: "ok", label: "config /p/sw.config.ts" });
  });

  it("explicit -c path that does not exist → warn", async () => {
    const c = await projectChecks({ ...base, configPath: "/p/nope.ts", exists: () => false });
    expect(c.find((x) => x.id === "config")).toMatchObject({
      status: "warn",
      label: "config not found: /p/nope.ts",
    });
  });

  it("typescript missing → info with the install command; present → ok with version", async () => {
    const miss = await projectChecks({
      cwd: "/p",
      discoverConfig: () => undefined,
      typescriptVersion: () => null,
    });
    expect(miss.find((x) => x.id === "typescript")).toMatchObject({ status: "info" });
    expect(miss.find((x) => x.id === "typescript")?.fix).toBe("npm i -D typescript@6 (next to second-world)");
    const ok = await projectChecks({ ...base, discoverConfig: () => undefined });
    expect(ok.find((x) => x.id === "typescript")?.label).toMatch(/^typescript 6\.0\.3/);
  });

  it("the real resolver finds the repo's typescript devDependency", async () => {
    const c = await projectChecks({ cwd: process.cwd() });
    expect(c.find((x) => x.id === "typescript")?.status).toBe("ok");
  });
});

describe("init summary", () => {
  const bare: ProjectDetection = { root: "/p", packageManager: "npm", frameworks: [], typescript: false };
  const answers = { targetUrl: "http://127.0.0.1:3000", healthPath: "/healthz" };

  it("bare project, non-interactive: says what is missing and that the target is a default", () => {
    const lines = initSummary(bare, answers, { interactive: false, targetFlag: false });
    expect(lines[0]).toBe("detected: npm · frameworks: none · OpenAPI: not found · start script: not found");
    expect(lines.join("\n")).toMatch(/target http:\/\/127\.0\.0\.1:3000 \(default, health \/healthz\)/);
    expect(lines.join("\n")).toMatch(/sw init --force --target <url>/);
    expect(lines.join("\n")).toMatch(/no start script found/);
    expect(lines.join("\n")).toMatch(/no OpenAPI file found: `sw bugs` needs one/);
    expect(lines.at(-1)).toBe("next: start your service, then run `sw doctor` and `sw perf`");
  });

  it("detected project with --target: no 'default' wording, no missing-item lines", () => {
    const d: ProjectDetection = {
      ...bare,
      frameworks: ["express"],
      openapi: "openapi.yaml",
      startScript: "start",
    };
    const lines = initSummary(d, answers, { interactive: false, targetFlag: true });
    expect(lines).toEqual([
      "detected: npm · frameworks: express · OpenAPI: openapi.yaml · start script: start",
      "target http://127.0.0.1:3000 (health /healthz)",
      "next: start your service, then run `sw doctor` and `sw perf`",
    ]);
  });
});

describe("doctor: os label", () => {
  it("a container on a WSL2 kernel (Docker Desktop) is not labelled WSL; plain WSL still is", async () => {
    const r = await probeEnvironment({ env: {} });
    const wslOs = {
      ...r.os,
      platform: "linux" as const,
      release: "6.6.87.2-microsoft-standard-WSL2",
      wsl: true,
    };
    const inContainer = doctorChecks({ ...r, os: wslOs, container: { inside: true, runtime: "docker" } });
    expect(inContainer.find((c) => c.id === "os")?.label).not.toMatch(/WSL$/);
    const inWsl = doctorChecks({ ...r, os: wslOs, container: { inside: false } });
    expect(inWsl.find((c) => c.id === "os")?.label).toMatch(/ WSL$/);
  });
});
