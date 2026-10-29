/**
 * Shared plumbing for engine commands (perf, stress, inspect): world creation from global flags,
 * Ctrl+C handling, report rendering/writing, history auto-save and the exit code.
 * See docs/09-cli-and-api.md §1 and docs/02-architecture.md §4.4.
 */
import { accessSync, constants, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConfigError } from "../core/errors.js";
import type { EngineResult } from "../core/evidence/schemas.js";
import { createWorld, type World } from "../core/world.js";
import { loadOptionsFromGlobals, parseSeed } from "./commands/config.js";
import { type GlobalOptions, VERSION } from "./main.js";
import { colorEnabled, err, makeLogger, out, style, unicodeEnabled } from "./output.js";

export async function worldFromGlobals(g: GlobalOptions): Promise<World> {
  const lo = loadOptionsFromGlobals(g);
  const seed = parseSeed(g);
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && !process.env.CI;
  return createWorld({
    ...(lo.configFile ? { config: lo.configFile } : {}),
    ...(lo.profile ? { profile: lo.profile } : {}),
    ...(lo.set ? { set: lo.set } : {}),
    ...(lo.overrides ? { overrides: lo.overrides } : {}),
    noConfigCode: lo.noConfigCode ?? false,
    interactive,
    approve: g.yes === true || g.approveDisruptive === true,
    ...(seed !== undefined ? { seed } : {}),
    logger: makeLogger(g),
  });
}

/** Report formats written as files (everything except the terminal table). */
function fileFormatsOf(world: World): string[] {
  return world.config.config.report.formats.filter((f) => f !== "tty");
}

/**
 * Fails fast (exit 2) when report files cannot be written, so a long run is not wasted.
 * No side effect: the nearest existing ancestor of report.outDir must be a writable directory.
 */
export function assertReportDirWritable(world: World): void {
  if (fileFormatsOf(world).length === 0) return;
  const outDir = resolve(world.config.cwd, world.config.config.report.outDir);
  let p = outDir;
  for (;;) {
    let st: ReturnType<typeof statSync> | undefined;
    try {
      st = statSync(p);
    } catch {
      st = undefined;
    }
    if (st) {
      const why = !st.isDirectory() ? `${p} is not a directory` : canWrite(p) ? undefined : `${p} is not writable`;
      if (why)
        throw new ConfigError("SW_CONFIG_OUTDIR", `Cannot write reports to ${outDir}: ${why}`, {
          hint: "Pass a writable -o/--out-dir (or report.outDir in sw.config)",
        });
      return;
    }
    const up = dirname(p);
    if (up === p)
      throw new ConfigError("SW_CONFIG_OUTDIR", `Cannot write reports to ${outDir}: no such drive or root`, {
        hint: "Pass a writable -o/--out-dir (or report.outDir in sw.config)",
      });
    p = up;
  }
}

function canWrite(p: string): boolean {
  try {
    accessSync(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run start for engine commands: checks the report directory (exit 2 before any load is sent), then
 * installs Ctrl+C handling. First signal → graceful world.cancel(); second → exit 130. Returns the uninstaller.
 */
export function installSignals(world: World, g: GlobalOptions, o: { reports?: boolean } = {}): () => void {
  if (o.reports !== false) assertReportDirWritable(world);
  const s = style(colorEnabled(g));
  let count = 0;
  const handler = (): void => {
    count++;
    if (count === 1) {
      err(`\n${s.warn} stopping gracefully (Ctrl+C again to abort)…`);
      world.cancel(new Error("interrupted"));
    } else {
      process.stderr.write("\naborted\n");
      process.exit(130);
    }
  };
  const sigs: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  if (process.platform === "win32") sigs.push("SIGBREAK");
  for (const sig of sigs) process.on(sig, handler);
  return () => {
    for (const sig of sigs) process.off(sig, handler);
  };
}

/** Prints live progress lines (perf.tick / stress.stage.*) on stderr. */
export function attachProgress(world: World, g: GlobalOptions, o: { json?: boolean }): void {
  if (g.quiet || o.json) return;
  const s = style(colorEnabled(g));
  const tty = process.stderr.isTTY === true;
  let last = 0;
  world.on("perf.tick", (p) => {
    const t = p as { elapsedS?: number; phase?: string; rps?: number; p95?: number; errors?: number; inFlight?: number };
    const now = Date.now();
    if (!tty && now - last < 5000) return;
    last = now;
    err(
      s.dim(
        `[${(t.elapsedS ?? 0).toFixed(0)}s ${t.phase ?? ""}] rps=${(t.rps ?? 0).toFixed(1)} p95=${(t.p95 ?? 0).toFixed(1)}ms errors=${t.errors ?? 0} inFlight=${t.inFlight ?? 0}`,
      ),
    );
  });
  world.on("stress.stage.end", (p) => {
    const t = p as { stage?: number; label?: string; level?: number; status?: string; p95?: number; throughput?: number; errorRate?: number };
    err(
      s.dim(
        `stage ${t.stage ?? "?"} ${t.label ?? ""} level=${t.level ?? ""} → ${t.status ?? ""} p95=${(t.p95 ?? 0).toFixed(1)}ms tput=${(t.throughput ?? 0).toFixed(1)}/s err=${((t.errorRate ?? 0) * 100).toFixed(2)}%`,
      ),
    );
  });
}

export interface FinishOptions {
  json?: boolean;
  /** commander `--no-history` → history === false */
  history?: boolean;
  label: string;
  /** Print nothing to stdout except what the caller prints (e.g. --graph). */
  suppressStdout?: boolean;
}

/** Renders/writes reports, auto-saves history, sets process.exitCode. */
export async function finishRun(world: World, result: EngineResult, g: GlobalOptions, o: FinishOptions): Promise<void> {
  const s = style(colorEnabled(g));
  const reporting = await import("../engines/reporting/index.js");
  const cfg = world.config.config;
  const failOn = cfg.report.failOn;
  const meta = { runId: result.runId, toolVersion: VERSION, command: ["sw", ...process.argv.slice(2)].join(" ") };
  const supported = reporting.REPORT_FORMATS as readonly string[];
  const formats = cfg.report.formats.filter((f) => supported.includes(f)) as Array<(typeof reporting.REPORT_FORMATS)[number]>;
  const dropped = cfg.report.formats.filter((f) => !supported.includes(f));
  if (dropped.length && !g.quiet) err(`${s.warn} report format(s) not supported yet: ${dropped.join(", ")}`);
  if (!o.suppressStdout) {
    if (o.json) out(reporting.renderReport(result, "json", { failOn, meta }));
    else if (formats.includes("tty")) {
      out(reporting.renderReport(result, "tty", { failOn, meta, color: colorEnabled(g), ascii: !unicodeEnabled() }));
    }
  }
  const fileFormats = formats.filter((f) => f !== "tty");
  let reportError: string | undefined;
  if (fileFormats.length > 0) {
    const outDir = resolve(world.config.cwd, cfg.report.outDir);
    try {
      const written = await reporting.writeReports(result, { formats: fileFormats, outDir, failOn, meta });
      if (!g.quiet) for (const f of written.files) err(s.dim(`report: ${f.path}`));
    } catch (e) {
      // The run itself is valid: report the write failure, still save history, exit 2.
      reportError = `Cannot write reports to ${outDir}: ${(e as Error).message}`;
      err(`${s.fail} ${reportError}`);
    }
  }
  if (o.history !== false && result.status !== "cancelled") {
    try {
      const saved = await world.history.save([result], { label: g.label ?? o.label });
      if (saved && !g.quiet) err(s.dim(`history: saved run ${saved.id}`));
    } catch (e) {
      err(`${s.warn} history not saved: ${(e as Error).message}`);
    }
  }
  process.exitCode = reportError !== undefined ? 2 : reporting.computeExitCode([result], failOn);
}
