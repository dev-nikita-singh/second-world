/**
 * Adversarial Test Agent public entry — docs/03-engines/adversarial-test-agent.md.
 * A bounded, safety-validated QA test-case generator over the Bug Hunter's session machinery.
 */
import { type CreateEngineContextOptions, createEngineContext } from "../../core/context.js";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { Engine } from "../../core/types.js";
import { type AgentData, type AgentDeps, ENGINE_VERSION, executeAgent } from "./engine.js";
import { type AgentInput, type AgentInputLoose, AgentInputSchema } from "./schema.js";

export type {
  AgentData,
  AgentDeps,
  AgentFindingSummary,
  HypothesisOutcome,
  HypothesisRecord,
  PlannerEnv,
  RejectedProposal,
  StopReason,
} from "./engine.js";
export type { SuggestedTest } from "./export.js";
export { suggestedTest } from "./export.js";
export { HeuristicPlanner } from "./planner/heuristic.js";
export type { Arm, Planner, PlanState } from "./planner/types.js";
export type { SafetyPolicy, ValidationResult } from "./safety.js";
export { validateProposal } from "./safety.js";
export type { Scenario, ScenarioInput } from "./scenario.js";
export { parseScenario, ScenarioSchema, scenarioFingerprint } from "./scenario.js";
export type { AgentInput, AgentInputLoose, AgentTechnique } from "./schema.js";
export { AGENT_TECHNIQUES, AgentInputSchema } from "./schema.js";

export const agentEngine: Engine<AgentInput, AgentData> = {
  id: "agent",
  version: ENGINE_VERSION,
  inputSchema: AgentInputSchema,
  requires: [{ cap: "network.target" }],
  run: (input, ctx) => executeAgent(input, ctx),
};

export function parseAgentInput(input: AgentInputLoose | unknown): AgentInput {
  const r = AgentInputSchema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map(
      (i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`,
    );
    throw new ConfigError("SW_CONFIG_AGENT", `Invalid agent input: ${issues.join("; ")}`, {
      hint: "See docs/03-engines/adversarial-test-agent.md for the input fields",
      details: { issues },
    });
  }
  return r.data;
}

/** Runs the agent standalone. Missing context members get test-friendly defaults. */
export async function runAgent(
  input: AgentInputLoose,
  ctx?: CreateEngineContextOptions,
  deps?: AgentDeps,
): Promise<EngineResult<AgentData>> {
  const parsed = parseAgentInput(input);
  const full = createEngineContext(ctx ?? {});
  return executeAgent(parsed, full, deps ?? {});
}
