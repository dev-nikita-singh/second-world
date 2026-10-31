/**
 * `sw inspect [path]` — Architecture Inspector. See docs/09-cli-and-api.md §1 and
 * docs/03-engines/architecture-inspector.md. Static analysis only: never executes project code.
 */
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { GlobalOptions } from "../main.js";
import { out } from "../output.js";
import { finishRun, installSignals, worldFromGlobals } from "../run-common.js";

const LEVELS = new Set(["off", "warn", "error"]);

/** `--rule ARCH004=off` (repeatable) → `{ ARCH004: "off" }`. */
export function parseRuleFlags(rules: string[] | undefined): Record<string, string> | undefined {
  if (!rules?.length) return undefined;
  const out: Record<string, string> = {};
  for (const r of rules) {
    const m = /^([A-Za-z][\w-]*)=(off|warn|error)$/i.exec(r.trim());
    if (!m || !LEVELS.has((m[2] as string).toLowerCase())) {
      throw new ConfigError("SW_CONFIG_FLAG", `Invalid --rule "${r}"`, {
        hint: "Use --rule ARCH004=off|warn|error",
      });
    }
    out[(m[1] as string).toUpperCase()] = (m[2] as string).toLowerCase();
  }
  return out;
}

export function inspectInputFromFlags(
  path: string | undefined,
  o: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (path) input.project = path;
  if (o.tsconfig) input.tsconfig = o.tsconfig;
  const rules = parseRuleFlags(o.rule as string[] | undefined);
  if (rules) input.rules = rules;
  if (o.cache === false) input.noCache = true;
  if (o.cacheDir) input.cacheDir = o.cacheDir;
  return input;
}

interface GraphLike {
  toDot(opts?: unknown): string;
  toMermaid(opts?: unknown): string;
  toJSON(): unknown;
}

export async function inspectCommand(
  path: string | undefined,
  o: Record<string, unknown>,
  g: GlobalOptions,
): Promise<void> {
  const graphFmt = o.graph as string | undefined;
  const world = await worldFromGlobals(g);
  const removeSignals = installSignals(world, g);
  try {
    const result = (await world.architecture.inspect(inspectInputFromFlags(path, o))) as EngineResult<{
      graph?: GraphLike;
    }>;
    if (graphFmt) {
      const graph = result.data?.graph;
      if (!graph) throw new ConfigError("SW_CONFIG_FLAG", "No dependency graph available for this run");
      const view = o.view ? { view: o.view } : undefined;
      if (graphFmt === "dot") out(graph.toDot(view));
      else if (graphFmt === "mermaid") out(graph.toMermaid(view));
      else out(JSON.stringify(graph.toJSON(), null, 2));
    }
    await finishRun(world, result as EngineResult, g, {
      json: o.json === true,
      history: o.history as boolean | undefined,
      label: "inspect",
      suppressStdout: graphFmt !== undefined,
    });
  } finally {
    removeSignals();
    await world.close();
  }
}
