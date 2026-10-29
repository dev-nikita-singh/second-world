/**
 * Performance Lab public entry. See docs/03-engines/performance-lab.md §8 (independent usage).
 */
import { createEngineContext } from "../../core/context.js";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { Engine, EngineContext } from "../../core/types.js";
import { ENGINE_VERSION, executePerformance, type PerformanceDeps } from "./engine.js";
import { type PerformanceInput, type PerformanceInputLoose, PerformanceInputSchema } from "./schema.js";
import type { PerformanceData } from "./types.js";

export type { PerformanceDeps } from "./engine.js";
export type {
  PerformanceInput,
  PerformanceInputLoose,
  PerformanceScenario,
  PerformanceStep,
} from "./schema.js";
export { PerformanceInputSchema } from "./schema.js";
export type * from "./types.js";

export const performanceEngine: Engine<PerformanceInput, PerformanceData> = {
  id: "performance",
  version: ENGINE_VERSION,
  inputSchema: PerformanceInputSchema,
  requires: [{ cap: "network.target" }],
  run: (input, ctx) => executePerformance(input, ctx),
};

/** Validates a loose input, throwing ConfigError with readable issue paths. */
export function parsePerformanceInput(input: PerformanceInputLoose | unknown): PerformanceInput {
  const r = PerformanceInputSchema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map(
      (i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`,
    );
    throw new ConfigError("SW_CONFIG_PERFORMANCE", `Invalid performance input: ${issues.join("; ")}`, {
      hint: "See docs/03-engines/performance-lab.md §3 for the input fields",
      details: { issues },
    });
  }
  return r.data;
}

/** Runs the Performance Lab standalone. Missing context members get test-friendly defaults. */
export async function runPerformance(
  input: PerformanceInputLoose,
  ctx?: Partial<EngineContext>,
  deps?: PerformanceDeps,
): Promise<EngineResult<PerformanceData>> {
  const parsed = parsePerformanceInput(input);
  const full = createEngineContext(ctx ?? {});
  return executePerformance(parsed, full, deps);
}
