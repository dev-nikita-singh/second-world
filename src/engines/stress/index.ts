/**
 * Stress & Capacity Lab public entry. See docs/03-engines/stress-capacity-lab.md.
 */

import { inConfigSection, suggestKey, zodIssueLines } from "../../core/config/loader.js";
import { parseThresholds, type ThresholdSpec } from "../../core/config/thresholds.js";
import { createEngineContext } from "../../core/context.js";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { Engine, EngineContext } from "../../core/types.js";
import { PerformanceInputSchema } from "../performance/schema.js";
import { executeStress, STRESS_ENGINE_VERSION, type StressDeps } from "./runner.js";
import { STRESS_KEYS, type StressInput, type StressInputLoose, StressInputSchema } from "./schema.js";
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
    const issues = zodIssueLines(r.error, { prefix: ["stress"], schema: StressInputSchema }).flatMap(
      expandBaseUnknownKeys,
    );
    throw new ConfigError(
      "SW_CONFIG_STRESS",
      `Invalid stress input: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      {
        hint: "See docs/03-engines/stress-capacity-lab.md for the input fields",
        details: { issues },
      },
    );
  }
  inConfigSection("stress", () =>
    parseThresholds(r.data.base.thresholds as Record<string, ThresholdSpec> | undefined),
  );
  return r.data;
}

/**
 * The base (Performance Lab keys) is validated inside a refinement, so its unknown keys arrive as a
 * custom `Unrecognized key: "x"` message on the parent path: expand them like the loader does.
 */
function expandBaseUnknownKeys(i: {
  path: string;
  message: string;
}): Array<{ path: string; message: string }> {
  const m = /^Unrecognized keys?: (.+)$/.exec(i.message);
  if (!m) return [i];
  const shape = (PerformanceInputSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
  const known = [...Object.keys(shape), ...STRESS_KEYS];
  return [...(m[1] as string).matchAll(/"([^"]*)"/g)].map((k) => {
    const key = k[1] as string;
    const hint = suggestKey(key, known);
    return { path: `${i.path}.${key}`, message: `Unknown key${hint ? ` (did you mean "${hint}"?)` : ""}` };
  });
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
