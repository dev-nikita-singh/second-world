import { describe, expect, it } from "vitest";
import {
  detectTerminal,
  doctorChecks,
  parseCpuQuota,
  parseFdLimit,
  parseMemLimit,
  probeEnvironment,
} from "../../../src/core/probe/probe.js";

describe("probe parsers", () => {
  it("cpu quota v2/v1", () => {
    expect(parseCpuQuota("max 100000", null, null)).toBeUndefined();
    expect(parseCpuQuota("200000 100000\n", null, null)).toBe(2);
    expect(parseCpuQuota(null, "50000", "100000")).toBe(0.5);
    expect(parseCpuQuota(null, "-1", "100000")).toBeUndefined();
    expect(parseCpuQuota(null, null, null)).toBeUndefined();
  });
  it("mem limit", () => {
    expect(parseMemLimit("max")).toBeUndefined();
    expect(parseMemLimit("536870912\n")).toBe(536870912);
    expect(parseMemLimit("9223372036854771712")).toBeUndefined();
    expect(parseMemLimit("garbage")).toBeUndefined();
  });
  it("fd limit", () => {
    const limits = "Limit Soft Limit Hard Limit Units\nMax open files            1024                 1048576              files\n";
    expect(parseFdLimit(limits)).toBe(1024);
    expect(parseFdLimit("Max open files unlimited unlimited files")).toBeUndefined();
    expect(parseFdLimit(null)).toBeUndefined();
  });
  it("terminal detection honours NO_COLOR / FORCE_COLOR / TERM=dumb", () => {
    expect(detectTerminal({ NO_COLOR: "1" }, { isTTY: true, columns: 100 })).toMatchObject({ tty: true, color: false, width: 100 });
    expect(detectTerminal({ FORCE_COLOR: "1" }, { isTTY: false })).toMatchObject({ tty: false, color: true, width: 80 });
    expect(detectTerminal({ FORCE_COLOR: "0" }, { isTTY: true })).toMatchObject({ color: false });
    expect(detectTerminal({ TERM: "dumb" }, { isTTY: true })).toMatchObject({ color: false });
    expect(detectTerminal({}, { isTTY: true })).toMatchObject({ color: true });
  });
});

describe("probeEnvironment", () => {
  it("cheap mode: no tools, full shape, never throws", async () => {
    const r = await probeEnvironment({ env: { HTTPS_PROXY: "http://user:pw123456@proxy:8080", NO_PROXY: "localhost, .internal", NODE_EXTRA_CA_CERTS: "/x.pem" } });
    expect(r.os.platform).toBe(process.platform);
    expect(r.runtime.name).toBe("node");
    expect(r.runtime.version).toBe(process.versions.node);
    expect(r.runtime.features.workerThreads).toBe(true);
    expect(typeof r.runtime.features.sqlite).toBe("boolean");
    expect(r.resources.cpus).toBeGreaterThanOrEqual(1);
    expect(r.resources.memTotal).toBeGreaterThan(0);
    expect(r.tools).toEqual({});
    expect(r.network.proxy).not.toContain("pw123456");
    expect(r.network.noProxy).toEqual(["localhost", ".internal"]);
    expect(r.network.extraCA).toBe(true);
    expect(r.capabilities["network.target"]?.available).toBe(true);
    expect(r.capabilities.git?.reason).toMatch(/not probed/);
  });
  it("full mode uses the tool runner and builds capabilities with fixes", async () => {
    const r = await probeEnvironment({
      full: true,
      env: {},
      runTool: async (t) => (t === "git" ? "git version 2.47.1.windows.1" : null),
    });
    expect(r.tools).toEqual({ git: "2.47.1" });
    expect(r.capabilities.git?.available).toBe(true);
    expect(r.capabilities.docker).toMatchObject({ available: false });
    expect(r.capabilities.docker?.fix).toBeTruthy();
  });
  it("tool runner failures are tolerated", async () => {
    const r = await probeEnvironment({
      full: true,
      env: {},
      runTool: async () => {
        throw new Error("boom");
      },
    });
    expect(r.tools).toEqual({});
  });
  it("doctorChecks produces a checklist", async () => {
    const r = await probeEnvironment({ env: { HTTPS_PROXY: "http://proxy:1" } });
    const checks = doctorChecks(r);
    expect(checks.find((c) => c.id === "runtime")?.status).toBe("ok");
    expect(checks.find((c) => c.id === "proxy")?.status).toBe("warn");
    for (const c of checks) expect(["ok", "warn", "fail", "info"]).toContain(c.status);
    const old = doctorChecks({ ...r, runtime: { ...r.runtime, version: "20.1.0" } });
    expect(old.find((c) => c.id === "runtime")).toMatchObject({ status: "fail" });
  });
  it("quick mode reports tools as not probed, not as missing (sw-qa wave 5)", async () => {
    const quick = doctorChecks(await probeEnvironment({ env: {} }));
    for (const t of ["git", "docker", "toxiproxy", "k6"]) {
      expect(quick.find((c) => c.id === `tool.${t}`)).toMatchObject({ status: "info", label: expect.stringMatching(/not probed/) });
    }
    const full = doctorChecks(await probeEnvironment({ full: true, env: {}, runTool: async () => null }));
    expect(full.find((c) => c.id === "tool.git")).toMatchObject({ status: "warn", label: "git not found" });
  });
});
