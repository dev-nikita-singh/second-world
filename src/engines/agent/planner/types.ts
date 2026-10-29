/**
 * Planner contract — docs/03-engines/adversarial-test-agent.md §1–§2.
 *
 * The heuristic planner exposes "arms" (operation × technique, the bandit's
 * choices) and turns an arm into candidate proposals. Proposals are untrusted data: the engine
 * validates every one (schema + safety policy + budget) before anything is executed.
 */
import type { CoverageTracker } from "../coverage.js";
import type { AgentTechnique } from "../schema.js";

export interface Arm {
  /** Stable key "technique METHOD /path". */
  key: string;
  technique: AgentTechnique;
  operation: string;
}

export interface PlanState {
  coverage: CoverageTracker;
  iteration: number;
  /** (rule, operation) pairs already confirmed; planners may skip them. */
  confirmed: ReadonlySet<string>;
  signal?: AbortSignal;
}

export interface Planner {
  readonly kind: "heuristic";
  arms(): Arm[];
  /** Candidate proposals for one arm, best first. An empty list means the arm is exhausted. */
  propose(arm: Arm, state: PlanState): Promise<unknown[]>;
}

export function armKey(technique: AgentTechnique, operation: string): string {
  return `${technique} ${operation}`;
}
