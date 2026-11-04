/**
 * `definePlugin` + API version check + namespacing (docs/10-plugins-and-extensibility.md §1, §3).
 * Pure and dependency-light: this module is what `second-world/plugin` ships.
 */
import semver from "semver";
import { ConfigError } from "../errors.js";
import { PLUGIN_API_VERSION, type PluginDefinition } from "./types.js";

const NAMESPACE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const LOCAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Checks a plugin's declared `apiVersion` against this build. A number must equal
 * PLUGIN_API_VERSION; a string is a semver range that must include `<PLUGIN_API_VERSION>.0.0`.
 * Returns a problem message, or undefined when compatible.
 */
export function apiVersionProblem(declared: unknown, current = PLUGIN_API_VERSION): string | undefined {
  if (typeof declared === "number") {
    if (!Number.isInteger(declared) || declared < 1) return `apiVersion ${declared} is not a valid version`;
    return declared === current
      ? undefined
      : `needs plugin API ${declared}, this SECOND WORLD provides plugin API ${current}`;
  }
  if (typeof declared === "string") {
    const range = semver.validRange(declared);
    if (range === null) return `apiVersion "${declared}" is not a semver range`;
    return semver.satisfies(`${current}.0.0`, range)
      ? undefined
      : `needs plugin API "${declared}", this SECOND WORLD provides plugin API ${current}`;
  }
  return "apiVersion is missing (expected apiVersion: 1)";
}

/** Shape problems of a plugin definition (empty when valid). */
export function definitionProblems(def: unknown): string[] {
  if (!def || typeof def !== "object") return ["the module does not export a plugin object"];
  const d = def as Partial<PluginDefinition>;
  const out: string[] = [];
  if (typeof d.name !== "string" || d.name.trim() === "") out.push("name must be a non-empty string");
  if (typeof d.setup !== "function") out.push("setup(api) must be a function");
  if (d.version !== undefined && typeof d.version !== "string") out.push("version must be a string");
  if (d.namespace !== undefined && (typeof d.namespace !== "string" || !NAMESPACE_RE.test(d.namespace)))
    out.push(`namespace must match ${NAMESPACE_RE}`);
  if (d.requires !== undefined && !Array.isArray(d.requires)) out.push("requires must be an array");
  const v = apiVersionProblem(d.apiVersion);
  if (v) out.push(v);
  return out;
}

/**
 * Identity helper with validation for plugin authors:
 *   export default definePlugin({ name: "@acme/sw-x", version: "1.0.0", apiVersion: 1, setup(api) {…} });
 * Throws a ConfigError (SW_CONFIG_PLUGIN_INVALID / SW_CONFIG_PLUGIN_API_VERSION) on a broken definition.
 */
export function definePlugin<T extends PluginDefinition>(def: T): T {
  const problems = definitionProblems(def);
  if (problems.length > 0) {
    const name = typeof def?.name === "string" ? def.name : "(unnamed)";
    const api = problems.every((p) => p.includes("plugin API") || p.startsWith("apiVersion"));
    throw new ConfigError(
      api ? "SW_CONFIG_PLUGIN_API_VERSION" : "SW_CONFIG_PLUGIN_INVALID",
      `plugin "${name}": ${problems.join("; ")}`,
      { hint: "See docs/10-plugins-and-extensibility.md §1 for the plugin shape" },
    );
  }
  return def;
}

/** Contribution prefix for a plugin: explicit `namespace`, else derived from the package name. */
export function namespaceOf(def: Pick<PluginDefinition, "name" | "namespace">): string {
  if (def.namespace) return def.namespace;
  let n = def.name.trim().toLowerCase();
  if (n.startsWith("@")) n = n.slice(1).split("/")[0] ?? n;
  else n = n.replace(/^(second-world-plugin-|sw-plugin-)/, "");
  n = n.replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return n || "plugin";
}

/**
 * Full contribution id: `id` → `<ns>/id`; `<ns>/id` stays; any other `x/id` is an error
 * (contributions are namespaced so plugins cannot shadow each other or the built-ins).
 */
export function qualifyId(ns: string, id: unknown, what: string): string {
  if (typeof id !== "string" || id.trim() === "")
    throw new ConfigError("SW_CONFIG_PLUGIN_INVALID", `${what} id must be a non-empty string`);
  const slash = id.indexOf("/");
  const local = slash < 0 ? id : id.slice(slash + 1);
  if (slash >= 0 && id.slice(0, slash) !== ns) {
    throw new ConfigError(
      "SW_CONFIG_PLUGIN_INVALID",
      `${what} "${id}" is outside the plugin's namespace "${ns}" (use "${ns}/${local}" or just "${local}")`,
    );
  }
  if (!LOCAL_ID_RE.test(local))
    throw new ConfigError("SW_CONFIG_PLUGIN_INVALID", `${what} id "${id}" must match ${LOCAL_ID_RE}`);
  return `${ns}/${local}`;
}
