/**
 * Plugin loading (docs/10-plugins-and-extensibility.md §3): resolve → import → validate (shape,
 * apiVersion, requires) → setup(api) into a staging area → namespace + clash checks → commit.
 *
 * `loadPlugins` never throws for a broken plugin: every plugin gets a PluginInfo with a status
 * (`loaded` | `failed` | `degraded` (optional plugin that failed) | `disabled`) so `sw plugins list|check`
 * can show all problems at once. `createWorld` turns the first failed *required* plugin into its
 * ConfigError (exit 2) and degraded ones into warnings + `PLUGIN_DEGRADED` limitations.
 *
 * Plugins run in-process and are trusted code, like ESLint plugins (docs/10 §3, docs/11).
 */
import { pathToFileURL } from "node:url";
import type { PluginEntry } from "../config/schema.js";
import { CapabilityError, ConfigError, isSecondWorldError } from "../errors.js";
import type { Limitation } from "../evidence/schemas.js";
import type { Logger } from "../types.js";
import { definitionProblems, namespaceOf, qualifyId } from "./define.js";
import { createHookRunner, type HookRunner } from "./hooks.js";
import { resolvePluginModule } from "./resolve.js";
import {
  PLUGIN_API_VERSION,
  PLUGIN_HOOK_EVENTS,
  type PluginApi,
  type PluginAssertion,
  type PluginDefinition,
  type PluginExport,
  type PluginHistoryStoreFactory,
  type PluginHookEvent,
  type PluginHookHandler,
  type PluginReporter,
  type PluginRuleLike,
  type PluginTsRuleLike,
} from "./types.js";

export const SETUP_TIMEOUT_MS = 30_000;

/** File suffixes of the built-in report formats (a plugin reporter may not reuse them). */
const BUILTIN_EXTENSIONS = new Set([".json", ".md", ".junit.xml", ".sarif", ".html"]);
const EXT_RE = /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface PluginSpec {
  /** Package name or relative path (or the inline plugin's name). */
  spec: string;
  optional: boolean;
  options: Record<string, unknown>;
  /** Programmatic plugin object (createWorld({ plugins: [...] })); skips resolution. */
  inline?: PluginExport;
}

export type ContributionKind = "reporter" | "rule" | "assertion" | "historyStore";

export type PluginStatus = "loaded" | "failed" | "degraded" | "disabled";

export interface PluginInfo {
  spec: string;
  name: string;
  version?: string;
  apiVersion?: number | string;
  namespace?: string;
  /** Resolved module file (absent for inline plugins and resolution failures). */
  path?: string;
  optional: boolean;
  status: PluginStatus;
  contributions: { kind: ContributionKind; id: string }[];
  hooks: PluginHookEvent[];
  error?: { code: string; message: string; hint?: string; exitCode: number };
}

export interface RegisteredReporter {
  plugin: string;
  id: string;
  extension: string;
  description?: string;
  options: Readonly<Record<string, unknown>>;
  render: PluginReporter["render"];
}

export interface RegisteredAssertion {
  plugin: string;
  id: string;
  options: Readonly<Record<string, unknown>>;
  fn: PluginAssertion;
}

export interface RegisteredHistoryStore {
  plugin: string;
  id: string;
  options: Readonly<Record<string, unknown>>;
  factory: PluginHistoryStoreFactory;
}

export interface PluginSet {
  /** False under `--no-plugins` / `--no-config-code` (nothing was imported). */
  readonly enabled: boolean;
  readonly plugins: PluginInfo[];
  readonly reporters: Map<string, RegisteredReporter>;
  /** Architecture rules (namespaced ids) and the AST extractors of `defineTsRule` rules. */
  readonly rules: PluginRuleLike[];
  readonly extractors: PluginTsRuleLike["extractor"][];
  readonly assertions: Map<string, RegisteredAssertion>;
  readonly historyStores: Map<string, RegisteredHistoryStore>;
  readonly hooks: HookRunner;
  readonly warnings: string[];
  /** One per degraded / disabled plugin; the world adds them to every engine result. */
  readonly limitations: Limitation[];
}

export interface LoadPluginsOptions {
  /** Config folder: base for relative paths and the start of the node_modules walk. */
  projectDir: string;
  log?: Logger;
  /** EnvironmentReport.capabilities: `requires` entries with `available: false` fail the plugin. */
  capabilities?: Partial<Record<string, { available: boolean; reason?: string; fix?: string }>>;
  /** Test seam: module importer (default: dynamic import of the file URL). */
  importModule?: (file: string) => Promise<unknown>;
  setupTimeoutMs?: number;
}

export function normalizePluginEntries(
  entries: readonly (PluginEntry | { name: string; optional?: boolean; options?: Record<string, unknown> })[],
): PluginSpec[] {
  return entries.map((e) =>
    typeof e === "string"
      ? { spec: e, optional: false, options: {} }
      : { spec: e.name, optional: e.optional ?? false, options: { ...(e.options ?? {}) } },
  );
}

function emptySet(enabled: boolean): PluginSet {
  return {
    enabled,
    plugins: [],
    reporters: new Map(),
    rules: [],
    extractors: [],
    assertions: new Map(),
    historyStores: new Map(),
    hooks: createHookRunner(),
    warnings: [],
    limitations: [],
  };
}

/** A set where every configured plugin is listed as `disabled` (nothing imported). */
export function disabledPluginSet(specs: readonly PluginSpec[], reason: string): PluginSet {
  const set = emptySet(false);
  for (const s of specs) {
    set.plugins.push({
      spec: s.spec,
      name: s.spec,
      optional: s.optional,
      status: "disabled",
      contributions: [],
      hooks: [],
    });
  }
  if (specs.length > 0) {
    const msg = `${specs.length} plugin(s) not loaded (${reason}): ${specs.map((s) => s.spec).join(", ")}`;
    set.warnings.push(msg);
    set.limitations.push({ code: "PLUGINS_DISABLED", message: msg, impact: "informational" });
  }
  return set;
}

function unsupported(point: string): never {
  throw new ConfigError(
    "SW_CONFIG_PLUGIN_UNSUPPORTED",
    `${point}() is not supported in SECOND WORLD 0.x (plugin API ${PLUGIN_API_VERSION})`,
    {
      hint: "Supported in 0.x: registerReporter, registerRule, registerAssertion, registerHistoryStore, hooks.on (docs/10 §2)",
    },
  );
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function pickExport(mod: unknown): unknown {
  if (!mod || (typeof mod !== "object" && typeof mod !== "function")) return mod;
  const m = mod as Record<string, unknown>;
  let ex: unknown = m.default ?? m.plugin ?? mod;
  // CJS transpiled `exports.default = plugin` imported from ESM: { default: { default: plugin } }.
  if (ex && typeof ex === "object" && !("setup" in ex) && "default" in ex)
    ex = (ex as Record<string, unknown>).default;
  return ex;
}

function errorInfo(
  e: unknown,
  fallbackCode: `SW_CONFIG_${string}`,
  name: string,
): NonNullable<PluginInfo["error"]> {
  const prefix = `plugin "${name}"`;
  if (isSecondWorldError(e)) {
    const message = e.message.startsWith(prefix) ? e.message : `${prefix}: ${e.message}`;
    return { code: e.code, message, ...(e.hint ? { hint: e.hint } : {}), exitCode: e.exitCode };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { code: fallbackCode, message: `${prefix}: ${msg}`, exitCode: 2 };
}

/** The error a failed plugin's info stands for (ConfigError / CapabilityError with the plugin name). */
export function pluginError(info: PluginInfo): ConfigError | CapabilityError {
  const err = info.error ?? {
    code: "SW_CONFIG_PLUGIN",
    message: `plugin "${info.name}" failed`,
    exitCode: 2,
  };
  const opts = { ...(err.hint ? { hint: err.hint } : {}), details: { plugin: info.name, spec: info.spec } };
  if (err.exitCode === 4)
    return new CapabilityError(
      err.code.startsWith("SW_CAP_") ? (err.code as `SW_CAP_${string}`) : "SW_CAP_PLUGIN",
      err.message,
      opts,
    );
  return new ConfigError(
    err.code.startsWith("SW_CONFIG_") ? (err.code as `SW_CONFIG_${string}`) : "SW_CONFIG_PLUGIN",
    err.message,
    opts,
  );
}

interface Staged {
  reporters: RegisteredReporter[];
  rules: PluginRuleLike[];
  extractors: PluginTsRuleLike["extractor"][];
  assertions: RegisteredAssertion[];
  stores: RegisteredHistoryStore[];
  hooks: { event: PluginHookEvent; fn: PluginHookHandler }[];
}

function isTsRule(r: unknown): r is PluginTsRuleLike {
  return !!r && typeof r === "object" && "extractor" in r && "rule" in r;
}

const RULE_DEFAULTS = {
  severity: "medium",
  category: "architecture",
  defaultLevel: "warn",
  docs: "",
  fix: "",
};

function stageRule(ns: string, r: unknown, staged: Staged): string {
  if (isTsRule(r)) {
    const id = qualifyId(ns, r.rule?.meta?.id, "rule");
    if (r.rule.meta.id !== id) {
      throw new ConfigError(
        "SW_CONFIG_PLUGIN_INVALID",
        `defineTsRule rule "${r.rule.meta.id}" must use its namespaced id "${id}" in ruleMeta(...)`,
      );
    }
    if (typeof r.extractor?.visit !== "function" || typeof r.rule.check !== "function")
      throw new ConfigError("SW_CONFIG_PLUGIN_INVALID", `rule "${id}" is not a defineTsRule(...) result`);
    staged.extractors.push(r.extractor);
    staged.rules.push(r.rule);
    return id;
  }
  const rule = r as Partial<PluginRuleLike> | undefined;
  if (!rule || typeof rule.check !== "function" || !rule.meta || typeof rule.meta !== "object")
    throw new ConfigError(
      "SW_CONFIG_PLUGIN_INVALID",
      "registerRule needs { meta: { id, title, … }, check(ctx) }",
    );
  const orig = rule.meta.id;
  const id = qualifyId(ns, orig, "rule");
  const meta = { ...RULE_DEFAULTS, ...rule.meta, id, title: String(rule.meta.title ?? id) };
  const check = rule.check.bind(rule);
  staged.rules.push({
    meta,
    check: (ctx) =>
      check(ctx).map((rep) =>
        rep && typeof rep === "object" && (rep as { ruleId?: unknown }).ruleId === orig && orig !== id
          ? { ...(rep as object), ruleId: id }
          : rep,
      ),
  });
  return id;
}

/** Loads every plugin; never throws for a plugin problem (see header). */
export async function loadPlugins(
  specs: readonly PluginSpec[],
  opts: LoadPluginsOptions,
): Promise<PluginSet> {
  const set = emptySet(true);
  const importModule = opts.importModule ?? ((file: string) => import(pathToFileURL(file).href));
  const names = new Set<string>();
  const extensions = new Map<string, string>();

  for (const spec of specs) {
    const info: PluginInfo = {
      spec: spec.spec,
      name: spec.spec,
      optional: spec.optional,
      status: "failed",
      contributions: [],
      hooks: [],
    };
    set.plugins.push(info);
    let stage = "load";
    try {
      // 1. resolve + import
      let ex: unknown;
      if (spec.inline !== undefined) ex = spec.inline;
      else {
        stage = "resolve";
        const file = resolvePluginModule(spec.spec, opts.projectDir);
        info.path = file;
        stage = "load";
        try {
          ex = pickExport(await importModule(file));
        } catch (e) {
          throw new ConfigError("SW_CONFIG_PLUGIN_LOAD", `cannot import ${file}: ${(e as Error).message}`, {
            cause: e,
          });
        }
      }
      if (typeof ex === "function") {
        stage = "factory";
        ex = await (ex as (o: Record<string, unknown>) => unknown)(spec.options);
      }
      // 2. validate
      stage = "validate";
      const def = ex as PluginDefinition;
      if (def && typeof def === "object" && typeof def.name === "string" && def.name) info.name = def.name;
      if (def && typeof def === "object") {
        if (typeof def.version === "string") info.version = def.version;
        if (typeof def.apiVersion === "number" || typeof def.apiVersion === "string")
          info.apiVersion = def.apiVersion;
      }
      const problems = definitionProblems(def);
      if (problems.length > 0) {
        const api = problems.every((p) => p.includes("plugin API") || p.startsWith("apiVersion"));
        throw new ConfigError(
          api ? "SW_CONFIG_PLUGIN_API_VERSION" : "SW_CONFIG_PLUGIN_INVALID",
          problems.join("; "),
          {
            hint: api
              ? `Upgrade the plugin (or SECOND WORLD); this build speaks plugin API ${PLUGIN_API_VERSION}`
              : "See docs/10-plugins-and-extensibility.md §1 for the plugin shape",
          },
        );
      }
      if (names.has(def.name))
        throw new ConfigError("SW_CONFIG_PLUGIN_CLASH", `is listed twice (or two packages share the name)`);
      const ns = namespaceOf(def);
      info.namespace = ns;
      for (const req of def.requires ?? []) {
        const c = opts.capabilities?.[req.cap];
        if (c && c.available === false && !req.optional) {
          throw new CapabilityError(
            "SW_CAP_PLUGIN_REQUIRES",
            `requires capability "${req.cap}"${c.reason ? ` (${c.reason})` : ""}`,
            {
              ...(c.fix ? { hint: c.fix } : {}),
            },
          );
        }
      }
      // 3. setup into a staging area
      stage = "setup";
      const staged: Staged = {
        reporters: [],
        rules: [],
        extractors: [],
        assertions: [],
        stores: [],
        hooks: [],
      };
      const contributions: PluginInfo["contributions"] = [];
      const options = Object.freeze({ ...spec.options });
      const log = opts.log?.child({ plugin: def.name });
      const api: PluginApi = {
        apiVersion: PLUGIN_API_VERSION,
        name: def.name,
        namespace: ns,
        options,
        log: {
          debug: (m, d) => log?.debug(m, d),
          info: (m, d) => log?.info(m, d),
          warn: (m, d) => log?.warn(m, d),
        },
        registerReporter(name, reporter) {
          const id = qualifyId(ns, name, "reporter");
          const r: Partial<PluginReporter> =
            typeof reporter === "function" ? { render: reporter } : (reporter ?? {});
          if (typeof r.render !== "function")
            throw new ConfigError("SW_CONFIG_PLUGIN_INVALID", `reporter "${id}" needs render(report)`);
          const extension = r.extension ?? `.${id.replace("/", "-")}.txt`;
          if (!EXT_RE.test(extension))
            throw new ConfigError(
              "SW_CONFIG_PLUGIN_INVALID",
              `reporter "${id}" extension "${extension}" must match ${EXT_RE}`,
            );
          staged.reporters.push({
            plugin: def.name,
            id,
            extension,
            ...(r.description ? { description: r.description } : {}),
            options,
            render: r.render.bind(r),
          });
          contributions.push({ kind: "reporter", id });
        },
        registerRule(rule) {
          contributions.push({ kind: "rule", id: stageRule(ns, rule, staged) });
        },
        registerAssertion(name, fn) {
          const id = qualifyId(ns, name, "assertion");
          if (typeof fn !== "function")
            throw new ConfigError("SW_CONFIG_PLUGIN_INVALID", `assertion "${id}" must be a function`);
          staged.assertions.push({ plugin: def.name, id, options, fn });
          contributions.push({ kind: "assertion", id });
        },
        registerHistoryStore(name, factory) {
          const id = qualifyId(ns, name, "history store");
          if (typeof factory !== "function")
            throw new ConfigError(
              "SW_CONFIG_PLUGIN_INVALID",
              `history store "${id}" must be a factory function`,
            );
          staged.stores.push({ plugin: def.name, id, options, factory });
          contributions.push({ kind: "historyStore", id });
        },
        registerExecutor: () => unsupported("registerExecutor"),
        registerExtractor: () => unsupported("registerExtractor"),
        registerFaultInjector: () => unsupported("registerFaultInjector"),
        registerEngine: () => unsupported("registerEngine"),
        registerTemplateHelper: () => unsupported("registerTemplateHelper"),
        registerTelemetrySource: () => unsupported("registerTelemetrySource"),
        hooks: {
          on(event, handler) {
            if (!(PLUGIN_HOOK_EVENTS as readonly string[]).includes(event))
              throw new ConfigError(
                "SW_CONFIG_PLUGIN_INVALID",
                `unknown hook "${String(event)}" (known: ${PLUGIN_HOOK_EVENTS.join(", ")})`,
              );
            if (typeof handler !== "function")
              throw new ConfigError("SW_CONFIG_PLUGIN_INVALID", `hook ${event} handler must be a function`);
            staged.hooks.push({ event, fn: handler as PluginHookHandler });
          },
        },
      };
      await withTimeout(
        Promise.resolve().then(() => def.setup(api)),
        opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        "setup()",
      );
      // 4. clashes (with earlier plugins and the built-ins)
      stage = "register";
      const clash = (what: string, id: string, owner: string): never => {
        throw new ConfigError(
          "SW_CONFIG_PLUGIN_CLASH",
          `${what} "${id}" is already registered by plugin "${owner}"`,
          {
            hint: "Contribution ids are namespaced by plugin; give one plugin a different `namespace`",
          },
        );
      };
      const seen = new Set<string>();
      for (const c of contributions) {
        const key = `${c.kind}:${c.id}`;
        if (seen.has(key))
          throw new ConfigError("SW_CONFIG_PLUGIN_CLASH", `registers ${c.kind} "${c.id}" twice`);
        seen.add(key);
      }
      for (const r of staged.reporters) {
        const prev = set.reporters.get(r.id);
        if (prev) clash("reporter", r.id, prev.plugin);
        if (BUILTIN_EXTENSIONS.has(r.extension))
          throw new ConfigError(
            "SW_CONFIG_PLUGIN_CLASH",
            `reporter "${r.id}" extension "${r.extension}" is used by a built-in format`,
          );
        const owner = extensions.get(r.extension);
        if (owner) clash("reporter extension", r.extension, owner);
      }
      for (const r of staged.rules) {
        const prev = set.rules.find((x) => x.meta.id === r.meta.id);
        if (prev)
          clash(
            "rule",
            r.meta.id,
            set.plugins.find((p) => p.contributions.some((c) => c.id === r.meta.id))?.name ?? "?",
          );
      }
      for (const a of staged.assertions) {
        const prev = set.assertions.get(a.id);
        if (prev) clash("assertion", a.id, prev.plugin);
      }
      for (const s of staged.stores) {
        const prev = set.historyStores.get(s.id);
        if (prev) clash("history store", s.id, prev.plugin);
      }
      // 5. commit
      for (const r of staged.reporters) {
        set.reporters.set(r.id, r);
        extensions.set(r.extension, def.name);
      }
      set.rules.push(...staged.rules);
      set.extractors.push(...staged.extractors);
      for (const a of staged.assertions) set.assertions.set(a.id, a);
      for (const s of staged.stores) set.historyStores.set(s.id, s);
      for (const h of staged.hooks) set.hooks.on(def.name, h.event, h.fn);
      names.add(def.name);
      info.contributions = contributions;
      info.hooks = set.hooks.eventsOf(def.name);
      info.status = "loaded";
    } catch (e) {
      info.error = errorInfo(
        e,
        stage === "setup"
          ? "SW_CONFIG_PLUGIN_SETUP"
          : stage === "factory"
            ? "SW_CONFIG_PLUGIN_LOAD"
            : "SW_CONFIG_PLUGIN",
        info.name,
      );
      info.contributions = [];
      if (spec.optional) {
        info.status = "degraded";
        const msg = `optional ${info.error.message}; continuing without it`;
        set.warnings.push(msg);
        set.limitations.push({ code: "PLUGIN_DEGRADED", message: msg, impact: "reduces-confidence" });
      } else info.status = "failed";
    }
  }
  return set;
}

/** First failed required plugin, if any. */
export function firstFailure(set: PluginSet): PluginInfo | undefined {
  return set.plugins.find((p) => p.status === "failed");
}
