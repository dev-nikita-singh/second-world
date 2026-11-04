/**
 * Shared plumbing for engine commands (perf, stress, inspect): world creation from global flags,
 * Ctrl+C handling, report rendering/writing, history auto-save and the exit code.
 * See docs/09-cli-and-api.md §1 and docs/02-architecture.md §4.4.
 */
import { accessSync, constants, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    noPlugins: g.plugins === false,
    interactive,
    approve: g.yes === true || g.approveDisruptive === true,
    ...(seed !== undefined ? { seed } : {}),
    logger: makeLogger(g),
  });
}

/** Lock file that serialises report writes into one `-o` directory (docs/02-architecture.md §4.6). */
export const REPORT_LOCK = ".sw-report.lock";

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
      const why = !st.isDirectory()
        ? `${p} is not a directory`
        : canWrite(p)
          ? undefined
          : `${p} is not writable`;
      if (why)
        throw new ConfigError("SW_CONFIG_OUTDIR", `Cannot write reports to ${outDir}: ${why}`, {
          hint: "Pass a writable -o/--out <dir> (or report.outDir in sw.config)",
        });
      return;
    }
    const up = dirname(p);
    if (up === p)
      throw new ConfigError("SW_CONFIG_OUTDIR", `Cannot write reports to ${outDir}: no such drive or root`, {
        hint: "Pass a writable -o/--out <dir> (or report.outDir in sw.config)",
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
      removeOwnTempFiles(world);
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

/**
 * Hard abort (second Ctrl+C) exits while writes may be in flight. Removes, synchronously, the temp
 * files and locks (history `.lock`, report-dir lock) that THIS process created (their names carry our pid): report temps
 * `.<name>.<pid>.<hex>.tmp` (src/shared/util/atomic-write.ts), history temps `<name>.tmp-<pid>-<hex>`
 * (src/engines/history/fsutil.ts) and `.lock` when its owner record is ours. Without it 10/10 hard
 * aborts during writes left files behind (tests/integration/robust/double-sigint.test.ts).
 * Best effort: never throws.
 */
export function removeOwnTempFiles(world: World): void {
  try {
    const cwd = world.config.cwd;
    const cfg = world.config.config as { report?: { outDir?: string }; history?: { dir?: string } };
    const pid = process.pid;
    const ours = new RegExp(`(\\.${pid}\\.[0-9a-f]+\\.tmp|\\.${pid}\\.tmp|\\.tmp-${pid}-[0-9a-f]+)$`);
    const dirs = [join(cwd, ".second-world", "model"), join(cwd, ".second-world", "cache", "arch")];
    const out = cfg.report?.outDir ? resolve(cwd, cfg.report.outDir) : undefined;
    if (out) dirs.push(out);
    const hist = cfg.history?.dir ? resolve(cwd, cfg.history.dir) : undefined;
    if (hist) dirs.push(hist, join(hist, "runs"));
    for (const d of dirs) {
      let names: string[];
      try {
        names = readdirSync(d);
      } catch {
        continue;
      }
      for (const n of names) if (ours.test(n)) tryUnlink(join(d, n));
    }
    const locks = [hist ? join(hist, ".lock") : "", out ? join(out, REPORT_LOCK) : ""];
    for (const lock of locks) {
      if (!lock) continue;
      try {
        const info = JSON.parse(readFileSync(lock, "utf8")) as { pid?: unknown; host?: unknown };
        if (info.pid === pid && info.host === hostname()) tryUnlink(lock);
      } catch {
        // no lock, or not readable: nothing of ours to remove
      }
    }
  } catch {
    // best effort on the way out
  }
}

function tryUnlink(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

/** Prints live progress lines (perf.tick / stress.stage.*) on stderr. */
export function attachProgress(world: World, g: GlobalOptions, o: { json?: boolean }): void {
  if (g.quiet || o.json) return;
  const s = style(colorEnabled(g));
  const tty = process.stderr.isTTY === true;
  let last = 0;
  world.on("perf.tick", (p) => {
    const t = p as {
      elapsedS?: number;
      phase?: string;
      rps?: number;
      p95?: number;
      errors?: number;
      inFlight?: number;
    };
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
    const t = p as {
      stage?: number;
      label?: string;
      level?: number;
      status?: string;
      p95?: number;
      throughput?: number;
      errorRate?: number;
    };
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
export async function finishRun(
  world: World,
  resultOrResults: EngineResult | readonly EngineResult[],
  g: GlobalOptions,
  o: FinishOptions,
): Promise<void> {
  // One engine result, or several (`sw run <workflow>`: one combined report, one history run).
  const results: EngineResult[] = Array.isArray(resultOrResults)
    ? [...(resultOrResults as readonly EngineResult[])]
    : [resultOrResults as EngineResult];
  const result: EngineResult | EngineResult[] = results.length === 1 ? (results[0] as EngineResult) : results;
  const first = results[0] as EngineResult;
  const s = style(colorEnabled(g));
  const reporting = await import("../engines/reporting/index.js");
  const cfg = world.config.config;
  const failOn = cfg.report.failOn;
  const meta = {
    runId: first.runId,
    toolVersion: VERSION,
    command: ["sw", ...process.argv.slice(2)].join(" "),
  };
  const saveHistory = async (): Promise<void> => {
    if (o.history === false || results.some((r) => r.status === "cancelled")) return;
    try {
      const saved = await world.history.save(results, { label: g.label ?? o.label });
      if (saved && !g.quiet) err(s.dim(`history: saved run ${saved.id}`));
      // Several results: the history run gets a new id; the combined report carries the same one.
      if (saved && results.length > 1) meta.runId = saved.id;
    } catch (e) {
      err(`${s.warn} history not saved: ${(e as Error).message}`);
    }
  };
  if (results.length > 1) {
    await saveHistory();
    if (meta.runId === first.runId) meta.runId = (await import("ulid")).ulid();
  }
  const supported = reporting.REPORT_FORMATS as readonly string[];
  const formats = cfg.report.formats.filter((f) => supported.includes(f)) as Array<
    (typeof reporting.REPORT_FORMATS)[number]
  >;
  // `world.plugins` is absent on hand-built worlds (tests, embedders on an older World shape).
  const isPluginFormat = (f: string): boolean => world.plugins?.hasFormat(f) === true;
  const dropped = cfg.report.formats.filter((f) => !supported.includes(f) && !isPluginFormat(f));
  const pluginFormats = cfg.report.formats.filter(isPluginFormat);
  if (dropped.length && !g.quiet) err(`${s.warn} report format(s) not supported yet: ${dropped.join(", ")}`);
  if (!o.suppressStdout) {
    if (o.json) out(reporting.renderReport(result, "json", { failOn, meta }));
    else if (formats.includes("tty")) {
      out(
        reporting.renderReport(result, "tty", {
          failOn,
          meta,
          color: colorEnabled(g),
          ascii: !unicodeEnabled(),
        }),
      );
    }
  }
  const fileFormats = formats.filter((f) => f !== "tty");
  let reportError: string | undefined;
  if (fileFormats.length > 0 || pluginFormats.length > 0) {
    const outDir = resolve(world.config.cwd, cfg.report.outDir);
    try {
      const write = async () => {
        const r = await reporting.writeReports(result, { formats: fileFormats, outDir, failOn, meta });
        const extra =
          pluginFormats.length > 0
            ? await world.plugins.writeReports(r.report, { formats: pluginFormats, outDir })
            : [];
        return { ...r, files: [...r.files, ...extra] };
      };
      // One run's reports per directory: parallel runs sharing `-o` take turns writing the whole set
      // (the last to finish owns every file). tests/unit/robust/shared-outdir.test.ts.
      const { LockTimeoutError, withLock } = await import("../engines/history/index.js");
      const written = await withLock(join(outDir, REPORT_LOCK), write).catch((e: unknown) => {
        if (!(e instanceof LockTimeoutError)) throw e;
        if (!g.quiet) err(`${s.warn} ${e.message}; writing reports without it`);
        return write();
      });
      if (!g.quiet) for (const f of written.files) err(s.dim(`report: ${f.path}`));
    } catch (e) {
      // The run itself is valid: report the write failure, still save history, exit 2.
      reportError = `Cannot write reports to ${outDir}: ${(e as Error).message}`;
      err(`${s.fail} ${reportError}`);
    }
  }
  if (results.length === 1) await saveHistory();
  process.exitCode = reportError !== undefined ? 2 : reporting.computeExitCode(results, failOn);
}
