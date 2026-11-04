/**
 * Glue between loaded plugins and the engines (docs/10-plugins-and-extensibility.md §2), used by the
 * composition root (src/core/world.ts). Structural only: no engine imports (docs/16 §1, R1).
 */
import { ConfigError } from "../errors.js";
import type { PluginSet, RegisteredReporter } from "./loader.js";
import type { PluginAssertionExchange, PluginAssertionResult } from "./types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** Same shape as the Bug Hunter's LoadedInvariant (src/engines/bugs/invariants.ts). */
export interface BoundAssertion {
  name: string;
  kind: "assertion";
  operations: string[];
  fn: (x: unknown) => PluginAssertionResult | Promise<PluginAssertionResult>;
}

function disabledHint(set: PluginSet): string {
  return set.enabled
    ? `Registered plugin assertions: ${[...set.assertions.keys()].join(", ") || "(none)"}`
    : "Plugins are disabled (--no-plugins / --no-config-code)";
}

/**
 * Splits `bugs.assertions` into built-in assertions (left in the input) and plugin assertions
 * `{ operation, use: "<ns>/<name>", args?, name? }`, bound to their plugin. Unknown `use` → ConfigError.
 */
export function bindPluginAssertions(
  set: PluginSet,
  assertions: unknown,
): { builtin: unknown[]; bound: BoundAssertion[] } {
  if (!Array.isArray(assertions)) return { builtin: [], bound: [] };
  const builtin: unknown[] = [];
  const bound: BoundAssertion[] = [];
  assertions.forEach((a, i) => {
    if (!isObj(a) || a.use === undefined) {
      builtin.push(a);
      return;
    }
    const where = `bugs.assertions.${i}`;
    const { use, args, operation, name, ...rest } = a;
    if (typeof use !== "string")
      throw new ConfigError(
        "SW_CONFIG_BUGS",
        `${where}.use: expected a plugin assertion id "namespace/name"`,
      );
    const extra = Object.keys(rest);
    if (extra.length > 0)
      throw new ConfigError(
        "SW_CONFIG_BUGS",
        `${where}: plugin assertions take only operation, use, args, name (unknown: ${extra.join(", ")})`,
      );
    if (typeof operation !== "string")
      throw new ConfigError(
        "SW_CONFIG_BUGS",
        `${where}.operation: expected an operation pattern like "GET /items"`,
      );
    if (args !== undefined && !isObj(args))
      throw new ConfigError("SW_CONFIG_BUGS", `${where}.args: expected an object`);
    const reg = set.assertions.get(use);
    if (!reg)
      throw new ConfigError("SW_CONFIG_BUGS", `${where}.use: unknown plugin assertion "${use}"`, {
        hint: disabledHint(set),
      });
    const frozenArgs = Object.freeze({ ...((args as Obj | undefined) ?? {}) });
    bound.push({
      name: typeof name === "string" && name ? name : use,
      kind: "assertion",
      operations: [operation],
      fn: async (x) => {
        const ex = x as PluginAssertionExchange;
        try {
          return await reg.fn(ex, frozenArgs, { operation: ex.operation, options: reg.options });
        } catch (e) {
          throw new Error(`plugin "${reg.plugin}": ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });
  });
  return { builtin, bound };
}

/** Renders one plugin report format; errors are wrapped with the plugin name (ConfigError, exit 2). */
export async function renderPluginReport(reg: RegisteredReporter, report: unknown): Promise<string> {
  let out: unknown;
  try {
    out = await reg.render(report as Readonly<Obj>, { format: reg.id, options: reg.options });
  } catch (e) {
    throw new ConfigError(
      "SW_CONFIG_PLUGIN_REPORTER",
      `plugin "${reg.plugin}" reporter ${reg.id} failed: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  if (typeof out !== "string")
    throw new ConfigError(
      "SW_CONFIG_PLUGIN_REPORTER",
      `plugin "${reg.plugin}" reporter ${reg.id} returned ${out === null ? "null" : typeof out}, expected a string`,
    );
  return out;
}

/** Methods a history store must have (HistoryStore interface, src/engines/history). */
export const HISTORY_STORE_METHODS = [
  "append",
  "get",
  "list",
  "query",
  "setBaseline",
  "getBaseline",
  "listBaselines",
  "diff",
  "trend",
  "verify",
  "prune",
] as const;

/** Checks a plugin history store; throws ConfigError SW_CONFIG_PLUGIN_HISTORY naming the plugin. */
export function assertHistoryStore(store: unknown, plugin: string, id: string): void {
  const missing = isObj(store)
    ? HISTORY_STORE_METHODS.filter((m) => typeof (store as Obj)[m] !== "function")
    : [...HISTORY_STORE_METHODS];
  if (missing.length > 0)
    throw new ConfigError(
      "SW_CONFIG_PLUGIN_HISTORY",
      `plugin "${plugin}" history store ${id} does not implement HistoryStore (missing: ${missing.join(", ")})`,
    );
}
