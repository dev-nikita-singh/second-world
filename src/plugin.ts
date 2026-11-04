/**
 * `second-world/plugin` — the plugin author entry (docs/10-plugins-and-extensibility.md §1, §4).
 *
 *   import { definePlugin } from "second-world/plugin";
 *   export default definePlugin({ name: "@acme/sw-extras", version: "1.0.0", apiVersion: 1, setup(api) { … } });
 *
 * Kept small: definePlugin and the API version check, the AST-rule helpers of the Architecture
 * Inspector, and types. Nothing here runs at import time.
 */

export { apiVersionProblem, definePlugin, namespaceOf } from "./core/plugins/define.js";
export {
  PLUGIN_API_VERSION,
  PLUGIN_HOOK_EVENTS,
  type PluginApi,
  type PluginAssertion,
  type PluginAssertionExchange,
  type PluginAssertionResult,
  type PluginCapabilityRequirement,
  type PluginDefinition,
  type PluginExport,
  type PluginHistoryStoreContext,
  type PluginHistoryStoreFactory,
  type PluginHookEvent,
  type PluginHookHandler,
  type PluginHookPayloads,
  type PluginLogger,
  type PluginReporter,
} from "./core/plugins/types.js";
export {
  defineTsRule,
  type TsRuleApi,
  type TsRuleDefinition,
} from "./engines/architecture/analyzer/ts/define-rule.js";
export type { TsExtractor } from "./engines/architecture/analyzer/ts/walker.js";
export {
  type ArchRule,
  meta as ruleMeta,
  type RuleContext,
  type RuleMeta,
  type RuleReport,
} from "./engines/architecture/rules/index.js";
export type { HistoryStore } from "./engines/history/index.js";
export type { CombinedReport } from "./engines/reporting/model.js";
