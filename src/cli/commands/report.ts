/**
 * `sw report [reports...] [--last] [--run <id>]` — combine and/or re-render earlier reports
 * (docs/09-cli-and-api.md §1 "sw report"). No network and no engine runs: the inputs are report.json
 * files (one EngineResult, an array, or a combined report) and history runs; the output is the same
 * combined report every engine command writes, built with `world.report` (src/engines/reporting).
 *
 * Files are written only when `-f/--format` or `-o/--out` is given, so re-rendering
 * `.second-world/reports/report.json` never overwrites it by accident. The exit code is the combined
 * report's verdict at `--fail-on` (the code the runs together would have produced); 2 for bad input.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { ReportFormatName, World } from "../../core/world.js";
import { type GlobalOptions, VERSION } from "../main.js";
import { colorEnabled, err, out, style, unicodeEnabled } from "../output.js";
import { assertReportDirWritable, REPORT_LOCK, worldFromGlobals } from "../run-common.js";

export interface ReportFlags {
  last?: boolean;
  run?: string[];
  json?: boolean;
}

interface Source {
  origin: string;
  results: EngineResult[];
  /** The input was one combined report: its id and meta are kept when it is the only source. */
  combined?: Record<string, unknown>;
}

type HistoryRunLike = { id: string; results?: EngineResult[] };
type StoreLike = {
  list(o: { limit: number }): Promise<Array<{ id: string }>>;
  get(id: string): Promise<HistoryRunLike | null>;
};

async function readReportFile(path: string, cwd: string): Promise<Source> {
  const { resultsFromJson } = await import("../../engines/summary/index.js");
  let text: string;
  try {
    text = await readFile(resolve(cwd, path), "utf8");
  } catch {
    throw new ConfigError("SW_CONFIG_REPORT", `cannot read report ${path}`, {
      hint: "Pass report.json files written by an engine command (default .second-world/reports/report.json)",
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError("SW_CONFIG_REPORT", `report ${path} is not valid JSON`);
  }
  const results = resultsFromJson(json, path);
  const combined =
    json && typeof json === "object" && (json as { kind?: unknown }).kind === "second-world-report"
      ? (json as Record<string, unknown>)
      : undefined;
  return { origin: path, results, ...(combined ? { combined } : {}) };
}

async function historySources(world: World, o: ReportFlags): Promise<Source[]> {
  const ids = [...(o.run ?? [])];
  if (!o.last && ids.length === 0) return [];
  const store = (await world.history.store()) as unknown as StoreLike;
  const outList: Source[] = [];
  const load = async (ref: string, flag: string): Promise<void> => {
    let run: HistoryRunLike | null;
    try {
      run = await store.get(ref);
    } catch (e) {
      throw new ConfigError("SW_CONFIG_REPORT", `${flag}: ${(e as Error).message}`);
    }
    if (!run) {
      throw new ConfigError("SW_CONFIG_REPORT", `${flag}: no run "${ref}" in history (or it was compacted)`, {
        hint: "`sw history list` shows run ids; a unique prefix (≥ 6 chars) or baseline:<name> works too",
      });
    }
    if (!run.results || run.results.length === 0) {
      throw new ConfigError("SW_CONFIG_REPORT", `${flag}: history run ${run.id} has no stored results`, {
        hint: "Compacted runs keep only their summary; pick a newer run",
      });
    }
    outList.push({ origin: `history run ${run.id}`, results: run.results });
  };
  for (const id of ids) await load(id, `--run ${id}`);
  if (o.last) {
    const latest = (await store.list({ limit: 1 }))[0];
    if (!latest) {
      throw new ConfigError("SW_CONFIG_REPORT", "--last: no run in history", {
        hint: "Run `sw perf`/`sw stress`/… first, or pass report.json paths",
      });
    }
    await load(latest.id, "--last");
  }
  return outList;
}

export async function reportCommand(paths: string[], o: ReportFlags, g: GlobalOptions): Promise<void> {
  const s = style(colorEnabled(g));
  const world = await worldFromGlobals(g);
  try {
    const cwd = world.config.invocationCwd ?? world.config.cwd;
    const sources: Source[] = [];
    for (const p of paths) sources.push(await readReportFile(p, cwd));
    sources.push(...(await historySources(world, o)));
    if (sources.length === 0) {
      throw new ConfigError("SW_CONFIG_REPORT", "No reports to combine", {
        hint: "Pass report.json files (e.g. .second-world/reports/report.json), --last, or --run <id>",
      });
    }
    // One result may arrive twice (a report file that is also the latest history run): keep the first.
    const seen = new Set<string>();
    const results: EngineResult[] = [];
    for (const src of sources) {
      for (const r of src.results) {
        const key = `${r.engine}:${r.runId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(r);
      }
    }
    const reporting = await import("../../engines/reporting/index.js");
    const cfg = world.config.config;
    const only = sources.length === 1 ? sources[0]?.combined : undefined;
    const meta: Record<string, unknown> = {
      toolVersion: VERSION,
      command: ["sw", ...process.argv.slice(2)].join(" "),
    };
    if (only) {
      // Re-rendering one combined report: keep its identity (run id, config hash, environment).
      for (const k of ["runId", "configHash", "environment"] as const)
        if (only[k] !== undefined) meta[k] = only[k];
    } else if (sources.length > 1) {
      const { ulid } = await import("ulid");
      meta.runId = ulid();
    }
    const report = world.report.combine(results, meta);

    const supported = reporting.REPORT_FORMATS as readonly string[];
    const formats = cfg.report.formats.filter((f) => supported.includes(f)) as ReportFormatName[];
    const dropped = cfg.report.formats.filter((f) => !supported.includes(f) && !world.plugins.hasFormat(f));
    const pluginFormats = cfg.report.formats.filter((f) => world.plugins.hasFormat(f));
    if (dropped.length && !g.quiet)
      err(`${s.warn} report format(s) not supported yet: ${dropped.join(", ")}`);
    if (!g.quiet && !o.json && sources.length > 1)
      err(s.dim(`combined ${results.length} result(s) from ${sources.length} source(s)`));

    if (o.json) out(world.report.render(report, "json"));
    else if (formats.includes("tty"))
      out(world.report.render(report, "tty", { color: colorEnabled(g), ascii: !unicodeEnabled() }));

    const explicit = g.format !== undefined || g.out !== undefined;
    const fileFormats = formats.filter((f) => f !== "tty");
    if (explicit && (fileFormats.length > 0 || pluginFormats.length > 0)) {
      assertReportDirWritable(world);
      const outDir = resolve(world.config.cwd, cfg.report.outDir);
      const { LockTimeoutError, withLock } = await import("../../engines/history/index.js");
      const write = () =>
        world.report.write(report, {
          formats: [...fileFormats, ...pluginFormats] as ReportFormatName[],
          outDir,
        });
      const written = await withLock(join(outDir, REPORT_LOCK), write).catch((e: unknown) => {
        if (!(e instanceof LockTimeoutError)) throw e;
        if (!g.quiet) err(`${s.warn} ${e.message}; writing reports without it`);
        return write();
      });
      if (!g.quiet) for (const f of written.files) err(s.dim(`report: ${f.path}`));
    }
    process.exitCode = world.report.exitCode(report);
  } finally {
    await world.close();
  }
}
