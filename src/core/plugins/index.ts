/**
 * Plugin system (docs/10-plugins-and-extensibility.md). Loaded lazily by the world only when the config
 * (or the API caller) lists plugins, so projects without plugins pay nothing at start-up.
 */
export { apiVersionProblem, definePlugin, definitionProblems, namespaceOf, qualifyId } from "./define.js";
export { createHookRunner, HOOK_TIMEOUT_MS, type HookFailure, type HookRunner } from "./hooks.js";
export {
  type ContributionKind,
  disabledPluginSet,
  firstFailure,
  type LoadPluginsOptions,
  loadPlugins,
  normalizePluginEntries,
  type PluginInfo,
  type PluginSet,
  type PluginSpec,
  type PluginStatus,
  pluginError,
  type RegisteredAssertion,
  type RegisteredHistoryStore,
  type RegisteredReporter,
  SETUP_TIMEOUT_MS,
} from "./loader.js";
export { isRelativeSpec, resolvePluginModule } from "./resolve.js";
export * from "./types.js";
export {
  assertHistoryStore,
  type BoundAssertion,
  bindPluginAssertions,
  HISTORY_STORE_METHODS,
  renderPluginReport,
} from "./wire.js";
