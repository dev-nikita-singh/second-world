/**
 * Stress & Capacity Lab public entry. See docs/03-engines/stress-capacity-lab.md.
 */
import { createEngineContext } from "../../core/context.js";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { Engine, EngineContext } from "../../core/types.js";
import { executeStress, STRESS_ENGINE_VERSION, type StressDeps } from "./runner.js";
import { type StressInput, type StressInputLoose, StressInputSchema } from "./schema.js";
import type { StressData } from "./types.js";

export * from "./analysis.js";
export {
  defaultMinStep,
  nextBisectionLevel,
  normalizeLevel,
  type PlannedStage,
  planStages,
  rangeLevels,
  type StageKind,
} from "./planner.js";
export type { StageRunner, StressDeps } from "./runner.js";
export { windowThresholds } from "./runner.js";
export {
  STRESS_KEYS,
  type StressInput,
  type StressInputLoose,
  StressInputSchema,
  type StressMode,
  stagePerfInput,
} from "./schema.js";
export type * from "./types.js";
export { fitUsl, uslThroughput } from "./usl.js";

export const stressEngine: Engine<StressInput, StressData> = {
  id: "stress",
  version: STRESS_ENGINE_VERSION,
  inputSchema: StressInputSchema as unknown as Engine<StressInput, StressData>["inputSchema"],
  requires: [{ cap: "network.target" }],
  run: (input, ctx) => executeStress(input, ctx),
};

export function parseStressInput(input: unknown): StressInput {
  const r = StressInputSchema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map(
      (i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`,
    );
    throw new ConfigError("SW_CONFIG_STRESS", `Invalid stress input: ${issues.join("; ")}`, {
      hint: "See docs/03-engines/stress-capacity-lab.md for the input fields",
      details: { issues },
    });
  }
  return r.data;
}

/** Runs the Stress & Capacity Lab standalone. Missing context members get test-friendly defaults. */
export async function runStress(
  input: StressInputLoose,
  ctx?: Partial<EngineContext>,
  deps?: StressDeps,
): Promise<EngineResult<StressData>> {
  const parsed = parseStressInput(input);
  return executeStress(parsed, createEngineContext(ctx ?? {}), deps);
}
