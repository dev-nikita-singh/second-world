/**
 * What-If & Evolution engines public entry. docs/03-engines/experiments.md.
 */
import { createEngineContext } from "../../core/context.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { Engine, EngineContext } from "../../core/types.js";
import { EVOLUTION_ENGINE_VERSION, type EvolutionDeps, executeEvolution } from "./evolution.js";
import {
  type EvolutionInput,
  type EvolutionInputLoose,
  EvolutionSchema,
  type ExperimentInput,
  type ExperimentInputLoose,
  ExperimentSchema,
  parseEvolutionInput,
  parseExperimentInput,
} from "./schema.js";
import type { EvolutionData, ExperimentData } from "./types.js";
import { executeExperiment, WHATIF_ENGINE_VERSION, type WhatIfDeps } from "./whatif.js";

export * from "./analysis.js";
export {
  getFreePort,
  type ReadyWhen,
  type RunningApp,
  type StartAppOptions,
  startApp,
  waitHealthy,
} from "./app.js";
export {
  type CommandResult,
  type CommandSpec,
  describeFailure,
  formatArgv,
  isAlive,
  killTree,
  runCommand,
  splitCommand,
  toArgv,
} from "./command.js";
export {
  EVOLUTION_ENGINE_VERSION,
  type EvolutionDeps,
  executeEvolution,
  type ReplayRunner,
} from "./evolution.js";
export {
  diffShortStat,
  parseShortStat,
  repoRoot,
  resolveCommit,
  type ShortStat,
  workingTreeChecksum,
} from "./git.js";
export { type InstallAction, lockInfo, materialize, planInstall } from "./install.js";
export { dominates, type ParetoItem, paretoFront, type RankedItem, rankPareto } from "./pareto.js";
export {
  type Projection,
  projectMm1,
  projectUsl,
  type QueueingProjection,
  type UslProjection,
} from "./projection.js";
export { createDockerSandbox, createProcessSandbox, dockerReachable, type Sandbox } from "./sandbox.js";
export { buildSchedule, type ScheduledRun, type ScheduleOrder } from "./schedule.js";
export * from "./schema.js";
export type * from "./types.js";
export {
  executeExperiment,
  resolveArms,
  WHATIF_ENGINE_VERSION,
  type WhatIfDeps,
  type WorkloadRunner,
} from "./whatif.js";
export { type Worktree, WorktreeManager } from "./worktree.js";

export const evolutionEngine: Engine<EvolutionInput, EvolutionData> = {
  id: "evolution",
  version: EVOLUTION_ENGINE_VERSION,
  inputSchema: EvolutionSchema as unknown as Engine<EvolutionInput, EvolutionData>["inputSchema"],
  requires: [{ cap: "git" }, { cap: "docker", optional: true }],
  run: (input, ctx) => executeEvolution(input, ctx),
};

/** Runs the Evolution engine standalone. Missing context members get test-friendly defaults. */
export async function runEvolution(
  input: EvolutionInputLoose,
  ctx?: Partial<EngineContext>,
  deps?: EvolutionDeps,
): Promise<EngineResult<EvolutionData>> {
  const parsed = parseEvolutionInput(input);
  return executeEvolution(parsed, createEngineContext(ctx ?? {}), deps);
}

export const whatIfEngine: Engine<ExperimentInput, ExperimentData> = {
  id: "whatif",
  version: WHATIF_ENGINE_VERSION,
  inputSchema: ExperimentSchema as unknown as Engine<ExperimentInput, ExperimentData>["inputSchema"],
  requires: [{ cap: "network.target" }],
  run: (input, ctx) => executeExperiment(input, ctx),
};

/** Runs a What-If experiment standalone. Missing context members get test-friendly defaults. */
export async function runExperiment(
  input: ExperimentInputLoose,
  ctx?: Partial<EngineContext>,
  deps?: WhatIfDeps,
): Promise<EngineResult<ExperimentData>> {
  const parsed = parseExperimentInput(input);
  return executeExperiment(parsed, createEngineContext(ctx ?? {}), deps);
}
