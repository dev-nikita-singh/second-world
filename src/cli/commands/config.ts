/**
 * `sw config print|validate|schema`. See docs/08-configuration.md §1.
 */
import { resolve } from "node:path";
import { loadConfig, type LoadConfigOptions, maskConfig, type ResolvedConfig } from "../../core/config/loader.js";
import { configJsonSchema } from "../../core/config/schema.js";
import { ConfigError } from "../../core/errors.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, err, out, style } from "../output.js";

/** Maps global CLI flags to config overrides (highest precedence). */
export function globalOverrides(g: GlobalOptions): Record<string, unknown> {
  const report: Record<string, unknown> = {};
  if (g.format) report.formats = g.format.split(",").map((s) => s.trim()).filter(Boolean);
  // Typed on the command line → relative to the shell cwd (docs/08 §1), not the config folder.
  if (g.out) report.outDir = resolve(process.cwd(), g.out);
  if (g.failOn) report.failOn = g.failOn;
  const o: Record<string, unknown> = {};
  if (Object.keys(report).length) o.report = report;
  return o;
}

export function parseSeed(g: GlobalOptions): number | undefined {
  if (g.seed === undefined) return undefined;
  const n = Number(g.seed);
  if (!Number.isInteger(n)) throw new ConfigError("SW_CONFIG_FLAG", `--seed must be an integer, got "${g.seed}"`);
  return n;
}

export function loadOptionsFromGlobals(g: GlobalOptions): LoadConfigOptions {
  return {
    cwd: process.cwd(),
    ...(g.config ? { configFile: g.config } : {}),
    ...(g.profile ? { profile: g.profile } : {}),
    ...(g.set?.length ? { set: g.set } : {}),
    overrides: globalOverrides(g),
    noConfigCode: g.configCode === false,
  };
}

async function toYaml(v: unknown): Promise<string> {
  const YAML = await import("yaml");
  return YAML.stringify(v);
}

export async function configPrint(o: { resolved?: boolean; json?: boolean }, g: GlobalOptions): Promise<void> {
  const r = await loadConfig(loadOptionsFromGlobals(g));
  for (const w of r.warnings) err(`warning: ${w}`);
  if (o.resolved) {
    const payload = { configFile: r.configFile ?? null, profile: r.profile ?? null, config: maskConfig(r.config), origins: r.origins };
    out(o.json ? JSON.stringify(payload, null, 2) : await toYaml(payload));
  } else {
    const masked = maskConfig(r.raw);
    out(o.json ? JSON.stringify(masked, null, 2) : await toYaml(masked));
  }
  process.exitCode = 0;
}

/**
 * Validates engine sections (currently `performance`) with the engine's own input schema, so
 * `sw config validate` catches what `sw perf` would reject. A missing target is filled with a
 * loopback placeholder (it is often given on the command line). Throws ConfigError (exit 2).
 */
export async function validateEngineSections(r: ResolvedConfig): Promise<void> {
  const perf = r.config.performance;
  if (perf === undefined) return;
  const { buildPerformanceInput } = await import("../../core/world.js");
  const { createRegistry } = await import("../../core/registry.js");
  const section: Record<string, unknown> = { ...perf };
  if (typeof section.auth === "string") {
    const name = section.auth;
    if (!(r.config.auth ?? {})[name]) {
      throw new ConfigError("SW_CONFIG_AUTH", `performance.auth "${name}" is not defined in config.auth`);
    }
    delete section.auth; // secrets are resolved at run time only
  }
  const cfgForCheck: ResolvedConfig = { ...r, config: { ...r.config, performance: section } };
  const input = buildPerformanceInput(cfgForCheck, {});
  if (input.target === undefined) input.target = "http://127.0.0.1/";
  const { module } = await createRegistry().load("performance");
  const m = module as { parsePerformanceInput?: (x: unknown) => unknown };
  if (typeof m.parsePerformanceInput === "function") m.parsePerformanceInput(input);
  if (input.thresholds && typeof input.thresholds === "object") {
    const { parseThresholds } = await import("../../core/config/thresholds.js");
    try {
      parseThresholds(input.thresholds as Parameters<typeof parseThresholds>[0]);
    } catch (e) {
      if (e instanceof ConfigError) {
        throw new ConfigError("SW_CONFIG_THRESHOLD", `performance.${e.message}`, { ...(e.hint ? { hint: e.hint } : {}) });
      }
      throw e;
    }
  }
}

export async function configValidate(o: { json?: boolean }, g: GlobalOptions): Promise<void> {
  const s = style(colorEnabled(g));
  try {
    const r = await loadConfig(loadOptionsFromGlobals(g));
    await validateEngineSections(r);
    if (o.json) out(JSON.stringify({ valid: true, configFile: r.configFile ?? null, warnings: r.warnings }));
    else {
      out(`${s.ok} config valid${r.configFile ? ` (${r.configFile})` : " (defaults, no config file found)"}`);
      for (const w of r.warnings) out(`${s.warn} ${w}`);
    }
    process.exitCode = 0;
  } catch (e) {
    if (o.json && e instanceof ConfigError) {
      out(JSON.stringify({ valid: false, code: e.code, message: e.message, details: e.details ?? null }));
      process.exitCode = e.exitCode;
      return;
    }
    throw e;
  }
}

export async function configSchema(): Promise<void> {
  out(JSON.stringify(configJsonSchema(), null, 2));
  process.exitCode = 0;
}
