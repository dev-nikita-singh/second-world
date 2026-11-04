/**
 * Plugin API types (docs/10-plugins-and-extensibility.md §1–3). Plugin API version 1.
 *
 * These types are structural on purpose: a plugin is loaded from the project's node_modules and may
 * import its own copy of `second-world/plugin`, so nothing here relies on `instanceof`. Engine-specific
 * shapes (architecture rules, history stores, the combined report) are typed loosely here because
 * src/core may not import engines (docs/16 §1, R1); `second-world/plugin` (src/plugin.ts) re-exports
 * the precise engine types for plugin authors.
 */

/** Current plugin API contract version. A plugin's `apiVersion` must match it (number or semver range). */
export const PLUGIN_API_VERSION = 1;

/** Lifecycle hooks (docs/10 §2). Hooks observe; they cannot change results. */
export const PLUGIN_HOOK_EVENTS = [
  "config.resolved",
  "run.started",
  "engine.started",
  "finding.created",
  "run.completed",
  "run.failed",
] as const;
export type PluginHookEvent = (typeof PLUGIN_HOOK_EVENTS)[number];

export interface PluginHookPayloads {
  "config.resolved": {
    config: Readonly<Record<string, unknown>>;
    configFile: string | undefined;
    cwd: string;
  };
  "run.started": { engine: string };
  "engine.started": { engine: string; engineVersion: string };
  "finding.created": { engine: string; finding: Readonly<Record<string, unknown>> };
  "run.completed": { engine: string; result: Readonly<Record<string, unknown>> };
  "run.failed": { engine: string; error: { code: string; message: string } };
}

export type PluginHookHandler<E extends PluginHookEvent = PluginHookEvent> = (
  payload: PluginHookPayloads[E],
) => void | Promise<void>;

/** A reporter: `render(report) → string` (docs/10 §2). `report` is the combined report (schemaVersion 1). */
export interface PluginReporter {
  /** File name suffix, e.g. ".txt" → report.txt. Default `.<namespace>-<name>.txt`. Must be unique. */
  extension?: string;
  description?: string;
  render(
    report: Readonly<Record<string, unknown>>,
    ctx: { format: string; options: Readonly<Record<string, unknown>> },
  ): string | Promise<string>;
}

/** What a Bug Hunter assertion sees: one HTTP exchange (same shape as invariant modules get). */
export interface PluginAssertionExchange {
  operation: string;
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  requestBody?: string;
}

/** `false` or a message = failed; `{ ok: false, message }` = failed; anything else = passed. */
export type PluginAssertionResult = boolean | string | undefined | { ok: boolean; message?: string };

export type PluginAssertion = (
  response: PluginAssertionExchange,
  args: Readonly<Record<string, unknown>>,
  ctx: { operation: string; options: Readonly<Record<string, unknown>> },
) => PluginAssertionResult | Promise<PluginAssertionResult>;

/** Architecture rule (`ArchRule` of src/engines/architecture): `{ meta: { id, … }, check(ctx) → reports }`. */
export interface PluginRuleLike {
  meta: { id: string; title: string };
  check(ctx: unknown): unknown[];
}

/** `defineTsRule(...)` result: an AST extractor plus the rule that turns its hits into findings. */
export interface PluginTsRuleLike {
  extractor: { id: string; version: string; kinds: readonly string[]; visit(...args: never[]): unknown };
  rule: PluginRuleLike;
}

export interface PluginHistoryStoreContext {
  /** Config folder. */
  cwd: string;
  /** Resolved `history.dir`. */
  dir: string;
  /** The plugin's options (`plugins: [{ name, options }]`). */
  options: Readonly<Record<string, unknown>>;
  isoNow(): string;
  onWarning(message: string): void;
}

/** Returns an object implementing the HistoryStore interface (src/engines/history). */
export type PluginHistoryStoreFactory = (ctx: PluginHistoryStoreContext) => object | Promise<object>;

export interface PluginLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

/** The object passed to `setup(api)`. */
export interface PluginApi {
  /** Plugin API version of this SECOND WORLD build. */
  readonly apiVersion: number;
  readonly name: string;
  /** Prefix of every contribution id (`<namespace>/<id>`). */
  readonly namespace: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly log: PluginLogger;
  /** New report format, usable as `-f <namespace>/<name>`. */
  registerReporter(name: string, reporter: PluginReporter | PluginReporter["render"]): void;
  /** Architecture rule (`ArchRule`) or a `defineTsRule(...)` result. */
  registerRule(rule: PluginRuleLike | PluginTsRuleLike): void;
  /** Bug Hunter assertion, used as `bugs.assertions: [{ operation, use: "<namespace>/<name>", args }]`. */
  registerAssertion(name: string, assertion: PluginAssertion): void;
  /** History backend, used as `history.backend: "<namespace>/<name>"`. */
  registerHistoryStore(name: string, factory: PluginHistoryStoreFactory): void;
  /** Not supported in 0.x (throws SW_CONFIG_PLUGIN_UNSUPPORTED). */
  registerExecutor(...args: unknown[]): never;
  registerExtractor(...args: unknown[]): never;
  registerFaultInjector(...args: unknown[]): never;
  registerEngine(...args: unknown[]): never;
  registerTemplateHelper(...args: unknown[]): never;
  registerTelemetrySource(...args: unknown[]): never;
  readonly hooks: {
    on<E extends PluginHookEvent>(event: E, handler: PluginHookHandler<E>): void;
  };
}

export interface PluginCapabilityRequirement {
  cap: string;
  optional?: boolean;
}

/** What `definePlugin({...})` takes and a plugin module exports. */
export interface PluginDefinition {
  name: string;
  version?: string;
  /** Plugin API contract version: `1`, or a semver range such as `"^1"`. */
  apiVersion: number | string;
  /** Contribution prefix; default derived from `name` (`@acme/sw-x` → `acme`, `sw-plugin-x` → `x`). */
  namespace?: string;
  description?: string;
  /** Capabilities from the environment report (`sw doctor`), e.g. `{ cap: "docker" }`. */
  requires?: readonly PluginCapabilityRequirement[];
  setup(api: PluginApi): void | Promise<void>;
}

/** A module's default export: a plugin, or a factory `(options) => plugin`. */
export type PluginExport =
  | PluginDefinition
  | ((options: Readonly<Record<string, unknown>>) => PluginDefinition | Promise<PluginDefinition>);
