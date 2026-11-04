/**
 * `sw plugins list|check [--json]` — docs/10-plugins-and-extensibility.md §3, docs/09 §1.
 *
 * list:  every configured plugin with version, apiVersion, namespace, contributions, hooks and status
 *        (loaded / failed / degraded / disabled). Exit 0 (2 only for an invalid config).
 * check: loads and validates every plugin and the config's references to plugin contributions
 *        (report.formats, history.backend, bugs.assertions[].use). Exit 2 when a required plugin is
 *        broken or a reference is unknown; degraded optional plugins are warnings (exit 0).
 * Plugins are never imported under --no-plugins or --no-config-code (they are listed as disabled).
 */
import { loadConfig, type ResolvedConfig } from "../../core/config/loader.js";
import { probeEnvironment } from "../../core/probe/probe.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, err, out, style } from "../output.js";
import { loadOptionsFromGlobals } from "./config.js";

type PluginsModule = typeof import("../../core/plugins/index.js");
type PluginSet = import("../../core/plugins/index.js").PluginSet;
type PluginInfo = import("../../core/plugins/index.js").PluginInfo;

/** `--no-plugins` (commander sets `plugins: false`). */
type Globals = GlobalOptions & { plugins?: boolean };

export interface PluginProblem {
  severity: "error" | "warning";
  plugin?: string;
  code: string;
  message: string;
  hint?: string;
}

export interface PluginsReport {
  enabled: boolean;
  /** Why plugins were not loaded (`--no-plugins` / `--no-config-code`). */
  disabledReason?: string;
  configFile: string | null;
  plugins: PluginInfo[];
  problems: PluginProblem[];
  ok: boolean;
}

async function loadSet(
  cfg: ResolvedConfig,
  g: Globals,
  p: PluginsModule,
): Promise<{ set: PluginSet; reason?: string }> {
  const specs = p.normalizePluginEntries(cfg.config.plugins);
  if (g.plugins === false) return { set: p.disabledPluginSet(specs, "--no-plugins"), reason: "--no-plugins" };
  if (g.configCode === false)
    return { set: p.disabledPluginSet(specs, "--no-config-code"), reason: "--no-config-code" };
  const env = await probeEnvironment({});
  return { set: await p.loadPlugins(specs, { projectDir: cfg.cwd, capabilities: env.capabilities }) };
}

/** Problems of the loaded set plus unknown references in the config. */
export function pluginProblems(cfg: ResolvedConfig, set: PluginSet): PluginProblem[] {
  const problems: PluginProblem[] = [];
  for (const info of set.plugins) {
    if (!info.error) continue;
    problems.push({
      severity: info.status === "failed" ? "error" : "warning",
      plugin: info.name,
      code: info.error.code,
      message: info.error.message,
      ...(info.error.hint ? { hint: info.error.hint } : {}),
    });
  }
  if (!set.enabled) return problems;
  const ref = (code: string, message: string, known: Iterable<string>): void => {
    problems.push({
      severity: "error",
      code,
      message,
      hint: `Registered: ${[...known].join(", ") || "(none)"}`,
    });
  };
  for (const f of cfg.config.report.formats)
    if (f.includes("/") && !set.reporters.has(f))
      ref(
        "SW_CONFIG_REPORT_FORMAT",
        `report.formats: unknown plugin report format "${f}"`,
        set.reporters.keys(),
      );
  const backend = cfg.config.history.backend;
  if (backend.includes("/") && !set.historyStores.has(backend))
    ref(
      "SW_CONFIG_HISTORY",
      `history.backend: unknown plugin history store "${backend}"`,
      set.historyStores.keys(),
    );
  const bugs = cfg.config.bugs as { assertions?: unknown } | undefined;
  if (Array.isArray(bugs?.assertions)) {
    bugs.assertions.forEach((a: unknown, i: number) => {
      const use = a && typeof a === "object" ? (a as { use?: unknown }).use : undefined;
      if (typeof use === "string" && !set.assertions.has(use))
        ref(
          "SW_CONFIG_BUGS",
          `bugs.assertions.${i}.use: unknown plugin assertion "${use}"`,
          set.assertions.keys(),
        );
    });
  }
  const arch = cfg.config.architecture as { rules?: unknown } | undefined;
  if (arch?.rules && typeof arch.rules === "object") {
    const ids = new Set(set.rules.map((r) => r.meta.id));
    for (const k of Object.keys(arch.rules))
      if (k.includes("/") && !ids.has(k))
        problems.push({
          severity: "warning",
          code: "SW_CONFIG_ARCHITECTURE",
          message: `architecture.rules: "${k}" is not a registered plugin rule (setting ignored)`,
          hint: `Plugin rules: ${[...ids].join(", ") || "(none)"}`,
        });
  }
  return problems;
}

export async function buildPluginsReport(g: Globals): Promise<PluginsReport> {
  const cfg = await loadConfig(loadOptionsFromGlobals(g));
  const p = await import("../../core/plugins/index.js");
  const { set, reason } = await loadSet(cfg, g, p);
  const problems = pluginProblems(cfg, set);
  return {
    enabled: set.enabled,
    ...(reason ? { disabledReason: reason } : {}),
    configFile: cfg.configFile ?? null,
    plugins: set.plugins,
    problems,
    ok: problems.every((x) => x.severity !== "error"),
  };
}

function contributionsText(info: PluginInfo): string {
  const parts = info.contributions.map((c) => `${c.kind} ${c.id}`);
  if (info.hooks.length) parts.push(`hooks ${info.hooks.join(",")}`);
  return parts.join("; ") || "-";
}

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(1, n - s.length));
}

function printTable(r: PluginsReport, g: Globals): void {
  const s = style(colorEnabled(g));
  if (r.plugins.length === 0) {
    out(
      "no plugins configured (add `plugins: [...]` to sw.config; see docs/10-plugins-and-extensibility.md)",
    );
    return;
  }
  if (!r.enabled && r.disabledReason) out(s.dim(`plugins not loaded (${r.disabledReason})`));
  const rows = r.plugins.map((p) => [
    p.name,
    p.version ?? "-",
    p.apiVersion === undefined ? "-" : String(p.apiVersion),
    p.status + (p.optional ? " (optional)" : ""),
    contributionsText(p),
  ]);
  const head = ["NAME", "VERSION", "API", "STATUS", "CONTRIBUTIONS"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)) + 2);
  out(head.map((h, i) => (i === head.length - 1 ? h : pad(h, widths[i] ?? 0))).join(""));
  for (const row of rows)
    out(row.map((c, i) => (i === row.length - 1 ? c : pad(c, widths[i] ?? 0))).join(""));
}

function printProblems(r: PluginsReport, g: Globals): void {
  const s = style(colorEnabled(g));
  for (const p of r.problems) {
    err(`${p.severity === "error" ? s.fail : s.warn} ${p.message} ${s.dim(`[${p.code}]`)}`);
    if (p.hint) err(`  ${s.dim("hint:")} ${p.hint}`);
  }
}

export async function pluginsList(o: { json?: boolean }, g: GlobalOptions): Promise<void> {
  const r = await buildPluginsReport(g as Globals);
  if (o.json) out(JSON.stringify(r, null, 2));
  else printTable(r, g as Globals);
  process.exitCode = 0;
}

export async function pluginsCheck(o: { json?: boolean }, g: GlobalOptions): Promise<void> {
  const r = await buildPluginsReport(g as Globals);
  if (o.json) out(JSON.stringify(r, null, 2));
  else {
    printTable(r, g as Globals);
    printProblems(r, g as Globals);
    const s = style(colorEnabled(g));
    if (r.ok) {
      const n = r.plugins.filter((p) => p.status === "loaded").length;
      out(
        r.enabled
          ? `${s.ok} ${n} plugin(s) loaded, no errors`
          : `${s.ok} plugins not loaded (${r.disabledReason}); nothing checked`,
      );
    }
  }
  process.exitCode = r.ok ? 0 : 2;
}
