/**
 * `sw plugins list|check [--json]` (src/cli/commands/plugins.ts), called as the CLI action would be.
 * When src/cli/main.ts registers the command, the last block also runs it as a real process.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type PluginsReport, pluginsCheck, pluginsList } from "../../../src/cli/commands/plugins.js";
import { buildProgram } from "../../../src/cli/main.js";
import { runCli } from "../../helpers/cli.js";
import { makePluginProject, type PluginProject } from "../../unit/plugins/project.js";

let proj: PluginProject;
beforeAll(async () => {
  proj = await makePluginProject();
});
afterAll(async () => {
  await proj.cleanup();
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function capture(): { stdout: () => string; stderr: () => string } {
  let o = "";
  let e = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    o += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    e += String(c);
    return true;
  });
  return { stdout: () => o, stderr: () => e };
}

describe("sw plugins list", () => {
  it("prints name, version, API, status and contributions", async () => {
    const config = proj.writeConfig({
      plugins: ["@acme/sw-extras", { name: "sw-plugin-cjs", optional: true }],
    });
    const c = capture();
    await pluginsList({}, { config, color: false });
    const lines = c.stdout().trimEnd().split("\n");
    expect(lines[0]).toMatch(/^NAME\s+VERSION\s+API\s+STATUS\s+CONTRIBUTIONS$/);
    expect(lines[1]).toMatch(
      /^@acme\/sw-extras\s+1\.2\.3\s+1\s+loaded\s+reporter acme\/summary; rule acme\/no-legacy-files; assertion acme\/sorted-by; historyStore acme\/file; hooks config\.resolved,run\.started,/,
    );
    expect(lines[2]).toMatch(/^sw-plugin-cjs\s+0\.4\.0\s+\^1\s+loaded \(optional\)\s+reporter cjs\/lines$/);
    expect(process.exitCode).toBe(0);
  });

  it("--json, and --no-plugins / --no-config-code list plugins as disabled without importing them", async () => {
    const config = proj.writeConfig({ plugins: ["./plugins/does-not-exist.mjs"] });
    let c = capture();
    await pluginsList({ json: true }, { config, plugins: false } as never);
    let r = JSON.parse(c.stdout()) as PluginsReport;
    expect(r).toMatchObject({ enabled: false, disabledReason: "--no-plugins", ok: true, problems: [] });
    expect(r.plugins[0]).toMatchObject({ spec: "./plugins/does-not-exist.mjs", status: "disabled" });
    vi.restoreAllMocks();
    c = capture();
    await pluginsList({ json: true }, { config, configCode: false });
    r = JSON.parse(c.stdout()) as PluginsReport;
    expect(r.disabledReason).toBe("--no-config-code");
  });

  it("no plugins configured", async () => {
    const config = proj.writeConfig({});
    const c = capture();
    await pluginsList({}, { config });
    expect(c.stdout()).toMatch(/^no plugins configured/);
  });
});

describe("sw plugins check", () => {
  it("exit 0 with a summary when everything loads and every reference exists", async () => {
    const config = proj.writeConfig({
      plugins: ["@acme/sw-extras"],
      report: { formats: ["json", "acme/summary"] },
      history: { backend: "acme/file" },
      bugs: { assertions: [{ operation: "GET /x", use: "acme/sorted-by" }] },
    });
    const c = capture();
    await pluginsCheck({}, { config, color: false });
    expect(c.stdout()).toMatch(/1 plugin\(s\) loaded, no errors/);
    expect(process.exitCode).toBe(0);
  });

  it("exit 2 on a broken required plugin and unknown references; optional failures are warnings", async () => {
    const config = proj.writeConfig({
      plugins: [
        "@acme/sw-extras",
        "./plugins/broken-plugins.mjs",
        { name: "@acme/not-installed", optional: true },
      ],
      report: { formats: ["acme/nope"] },
      history: { backend: "acme/s3" },
      bugs: { assertions: [{ operation: "GET /x", use: "acme/unknown" }] },
      architecture: { rules: { "acme/typo": "off" } },
    });
    const c = capture();
    await pluginsCheck({ json: true }, { config });
    const r = JSON.parse(c.stdout()) as PluginsReport;
    expect(process.exitCode).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.plugins.map((p) => p.status)).toEqual(["loaded", "failed", "degraded"]);
    expect(r.problems.map((p) => [p.severity, p.code])).toEqual([
      ["error", "SW_CONFIG_PLUGIN_INVALID"],
      ["warning", "SW_CONFIG_PLUGIN_NOT_FOUND"],
      ["error", "SW_CONFIG_REPORT_FORMAT"],
      ["error", "SW_CONFIG_HISTORY"],
      ["error", "SW_CONFIG_BUGS"],
      ["warning", "SW_CONFIG_ARCHITECTURE"],
    ]);
    expect(r.problems[2]).toMatchObject({
      message: 'report.formats: unknown plugin report format "acme/nope"',
      hint: "Registered: acme/summary",
    });
    vi.restoreAllMocks();
    const t = capture();
    await pluginsCheck({}, { config, color: false });
    expect(t.stderr()).toContain('plugin "./plugins/broken-plugins.mjs": name must be a non-empty string');
    expect(process.exitCode).toBe(2);
  });

  it("an optional-only failure keeps exit 0", async () => {
    const config = proj.writeConfig({ plugins: [{ name: "@acme/not-installed", optional: true }] });
    capture();
    await pluginsCheck({ json: true }, { config });
    expect(process.exitCode).toBe(0);
  });
});

const registered = buildProgram().commands.some((c) => c.name() === "plugins");

describe.runIf(registered)("sw plugins as a process (main.ts registration)", () => {
  it("check --json exits 2 for a broken required plugin; --no-plugins skips it", async () => {
    proj.writeConfig({ plugins: ["./plugins/broken-plugins.mjs"] });
    const bad = await runCli(["plugins", "check", "--json"], { cwd: proj.path });
    expect(bad.exitCode, bad.stderr).toBe(2);
    expect((JSON.parse(bad.stdout) as PluginsReport).plugins[0]?.status).toBe("failed");
    const off = await runCli(["--no-plugins", "plugins", "list", "--json"], { cwd: proj.path });
    expect(off.exitCode, off.stderr).toBe(0);
    expect((JSON.parse(off.stdout) as PluginsReport).plugins[0]?.status).toBe("disabled");
  }, 60_000);
});
