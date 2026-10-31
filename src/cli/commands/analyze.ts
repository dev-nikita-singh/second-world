/**
 * `sw analyze <report...>` — deterministic summary over previous reports (docs/09-cli-and-api.md §1).
 * No AI and no network: counts, strongest evidence first, top findings and invalidating limitations,
 * all taken from the reports. Informational: exit 0 unless the input cannot be read.
 */
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, err, out, style } from "../output.js";
import { worldFromGlobals } from "../run-common.js";

export interface AnalyzeFlags {
  last?: boolean;
  top?: string;
  json?: boolean;
}

export async function analyzeCommand(paths: string[], o: AnalyzeFlags, g: GlobalOptions): Promise<void> {
  const s = style(colorEnabled(g));
  const world = await worldFromGlobals(g);
  try {
    const { deterministicSummary, loadReports } = await import("../../engines/summary/index.js");
    const results: EngineResult[] = await loadReports(paths, world.config.invocationCwd ?? world.config.cwd);
    if (o.last) {
      const store = (await world.history.store()) as unknown as {
        list(o: { limit: number }): Promise<Array<{ id: string; engines: string[] }>>;
        get(id: string): Promise<{ id: string; results: EngineResult[] } | null>;
      };
      const latest = (await store.list({ limit: 1 }))[0];
      const run = latest ? await store.get(latest.id) : null;
      if (!run) {
        throw new ConfigError("SW_CONFIG_REPORT", "--last: no run in history", {
          hint: "Run `sw perf`/`sw stress`/… first, or pass report.json paths",
        });
      }
      // The latest run may also have been passed as a report file: count each result once.
      const seen = new Set(results.map((r) => `${r.engine}:${r.runId}`));
      results.push(...run.results.filter((r) => !seen.has(`${r.engine}:${r.runId}`)));
      if (!g.quiet && !o.json) err(s.dim(`analyzing history run ${run.id}`));
    }
    if (results.length === 0) {
      throw new ConfigError("SW_CONFIG_REPORT", "No reports to analyze", {
        hint: "Pass one or more report.json files (e.g. .second-world/reports/report.json) or --last",
      });
    }
    const top = o.top !== undefined ? Number(o.top) : undefined;
    if (top !== undefined && (!Number.isInteger(top) || top < 0)) {
      throw new ConfigError("SW_CONFIG_FLAG", `--top must be a non-negative integer, got "${o.top}"`);
    }
    const summary = deterministicSummary(results, top !== undefined ? { top } : {});
    out(
      o.json
        ? JSON.stringify(world.redactor.redactObject(summary), null, 2)
        : world.redactor.redactString(summary.text),
    );
  } finally {
    await world.close();
  }
}
