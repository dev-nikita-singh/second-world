/**
 * Architecture Inspector — public entry. docs/03-engines/architecture-inspector.md.
 * `typescript` is loaded lazily inside the analyzer, so importing this module is cheap.
 */
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { Engine, EngineContext } from "../../core/types.js";
import { type ArchitectureData, type ArchitectureDeps, ENGINE_VERSION, runArchitecture } from "./engine.js";
import { type ArchitectureInput, type ArchitectureInputLoose, ArchitectureInputSchema } from "./schema.js";

export type { AnalyzeRequest, AnalyzeResult, SourceAnalyzer } from "./analyzer/source-analyzer.js";
export { defineTsRule } from "./analyzer/ts/define-rule.js";
export { createTsAnalyzer, type TsExtractor } from "./analyzer/ts/index.js";
export type { ArchitectureData, ArchitectureDeps } from "./engine.js";
export { ENGINE_VERSION, parseArchitectureInput } from "./engine.js";
export { ArchitectureGraph, type GraphViewOptions, toDot, toMermaid } from "./graph.js";
export {
  type ArchRule,
  BUILTIN_RULES,
  hitRule,
  meta as ruleMeta,
  type RuleContext,
  type RuleMeta,
  type RuleReport,
} from "./rules/index.js";
export * from "./schema.js";
export type * from "./types.js";

/** Run the inspector. `ctx` may be partial (test-friendly defaults via createEngineContext). */
export function inspectArchitecture(
  input: ArchitectureInputLoose | ArchitectureInput = {},
  ctx: Partial<EngineContext> = {},
  deps: ArchitectureDeps = {},
): Promise<EngineResult<ArchitectureData>> {
  return runArchitecture(input, ctx, deps);
}

export const architectureEngine: Engine<ArchitectureInput, ArchitectureData> = {
  id: "architecture",
  version: ENGINE_VERSION,
  inputSchema: ArchitectureInputSchema as unknown as Engine<
    ArchitectureInput,
    ArchitectureData
  >["inputSchema"],
  requires: [{ cap: "fs.read" }],
  run: (input, ctx) => runArchitecture(input, ctx),
};
