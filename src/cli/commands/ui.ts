/**
 * `sw ui [--port <n>] [--no-open]` — the local browser UI (docs/09-cli-and-api.md §1 "sw ui").
 * Starts the UI server on 127.0.0.1 (src/ui/server), prints the URL with its session token and opens the
 * default browser. Runs until Ctrl+C; a running test is stopped gracefully first.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError } from "../../core/errors.js";
import type { GlobalOptions } from "../main.js";
import { VERSION } from "../main.js";
import { colorEnabled, err, out, style } from "../output.js";
import { worldFromGlobals } from "../run-common.js";

export interface UiFlags {
  port?: string;
  /** commander `--no-open` → false */
  open?: boolean;
}

/** Global flags each test started from the UI must repeat so it sees the same config. */
export function childGlobals(g: GlobalOptions, configFile: string | undefined): string[] {
  const a: string[] = [];
  if (configFile) a.push("--config", configFile);
  if (g.profile) a.push("--profile", g.profile);
  for (const s of g.set ?? []) a.push("--set", s);
  if (g.configCode === false) a.push("--no-config-code");
  if (g.plugins === false) a.push("--no-plugins");
  if (g.failOn) a.push("--fail-on", g.failOn);
  return a;
}

/** Opens a URL in the default browser without a shell (the URL carries the token in its fragment). */
export function openBrowser(url: string): void {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]+$/.test(url)) return;
  const done = () => {};
  if (process.platform === "win32")
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url}'`],
      { windowsHide: true },
      done,
    );
  else if (process.platform === "darwin") execFile("open", [url], done);
  else execFile("xdg-open", [url], done);
}

export async function uiCommand(o: UiFlags, g: GlobalOptions): Promise<void> {
  const s = style(colorEnabled(g));
  const port = o.port === undefined ? 4777 : Number(o.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new ConfigError("SW_CONFIG_FLAG", `--port must be a port number (0-65535), got "${o.port}"`);

  const first = await worldFromGlobals(g);
  const configFile = first.config.configFile;
  const globals = childGlobals(g, configFile);

  const [{ startUiServer }, { JobRunner }, { resolveAssets }, { listScenarios }, probe, project] =
    await Promise.all([
      import("../../ui/server/server.js"),
      import("../../ui/server/jobs.js"),
      import("../../ui/server/assets.js"),
      import("../../engines/reliability/index.js"),
      import("../../core/probe/probe.js"),
      import("../../core/probe/project.js"),
    ]);

  if (import.meta.url.endsWith(".ts") && !process.env.SECOND_WORLD_UI_ASSETS)
    err(s.dim("building the UI (running from source)…"));
  const assets = await resolveAssets();
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
  const runner = new JobRunner({
    file: process.execPath,
    prefix: [...process.execArgv, entry],
    cwd: process.cwd(),
  });
  const server = await startUiServer({
    loadWorld: () => worldFromGlobals(g),
    initialWorld: first,
    runner,
    assets,
    version: VERSION,
    globals,
    scenarios: listScenarios().map((x) => ({ id: x.id, title: x.title })),
    doctor: async () => {
      const report = await probe.probeEnvironment({ full: true });
      const cwd = process.cwd();
      const checks = [
        ...probe.doctorChecks(report),
        ...(await project.projectChecks({
          cwd,
          ...(g.config ? { configPath: resolve(cwd, g.config) } : {}),
        })),
      ];
      return { ...report, checks };
    },
    port,
  });

  if (server.port !== port && port !== 0) err(s.dim(`port ${port} is in use; using ${server.port}`));
  out(`${s.bold("SECOND WORLD UI")} → ${server.openUrl}`);
  err(
    s.dim(
      `${configFile ? `project: ${configFile}` : "no sw.config found: the UI shows history only"}\n` +
        "Only this computer can open it; the link contains a private session key. Ctrl+C to stop.",
    ),
  );
  if (o.open !== false) openBrowser(server.openUrl);

  await new Promise<void>((done) => {
    let stopping = false;
    const stop = () => {
      if (stopping) process.exit(130);
      stopping = true;
      err(s.dim("\nstopping the UI…"));
      server.close().then(done, done);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    if (process.platform === "win32") process.on("SIGBREAK", stop);
  });
  process.exitCode = 0;
}
