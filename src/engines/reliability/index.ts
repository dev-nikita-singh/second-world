/**
 * Reliability Lab public entry. See docs/03-engines/reliability-lab.md.
 *
 * - `reliabilityEngine` (Engine<ReliabilityInput, ReliabilityData>) for the registry/orchestrator
 * - `runReliability(input, ctxPartial?, deps?)` standalone (test-friendly context defaults)
 * - `listScenarios()` for `sw reliability list`
 * - `cleanupAll()` for `sw reliability cleanup` (in-process stack + ledger of external faults)
 */

import { zodIssueLines } from "../../core/config/loader.js";
import { parseThreshold } from "../../core/config/thresholds.js";
import { createEngineContext } from "../../core/context.js";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { Engine, EngineContext } from "../../core/types.js";
import { ENGINE_VERSION } from "./findings.js";
import { executeReliability, type ReliabilityDeps } from "./runner.js";
import { getScenario } from "./scenarios.js";
import { type ReliabilityInput, type ReliabilityInputLoose, ReliabilityInputSchema } from "./schema.js";
import type { ReliabilityData } from "./types.js";

export { type CleanupAllResult, cleanupAll } from "../../adapters/faults/cleanup.js";
export type * from "./detectors.js";
export { type ReliabilityDeps, recordingExecutor } from "./runner.js";
export { getScenario, listScenarios, type ScenarioDef } from "./scenarios.js";
export { type ReliabilityInput, type ReliabilityInputLoose, ReliabilityInputSchema } from "./schema.js";
export type * from "./types.js";

export const reliabilityEngine: Engine<ReliabilityInput, ReliabilityData> = {
  id: "reliability",
  version: ENGINE_VERSION,
  inputSchema: ReliabilityInputSchema,
  requires: [{ cap: "network.target" }, { cap: "docker", optional: true }],
  run: (input, ctx) => executeReliability(input, ctx),
};

/** Validates a loose input, throwing ConfigError with readable issue paths. */
export function parseReliabilityInput(input: ReliabilityInputLoose | unknown): ReliabilityInput {
  const r = ReliabilityInputSchema.safeParse(input);
  if (!r.success) {
    const issues = zodIssueLines(r.error, { prefix: ["reliability"], schema: ReliabilityInputSchema });
    throw new ConfigError(
      "SW_CONFIG_RELIABILITY",
      `Invalid reliability input: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      {
        hint: "See docs/03-engines/reliability-lab.md",
        details: { issues },
      },
    );
  }
  return r.data;
}

/**
 * Checks the runner makes before touching the target (same rules and wording), for `--dry-run`:
 * unknown scenario, maxDuration, steadyState/hypothesis expressions (docs/03-engines/reliability-lab.md §3).
 */
export function checkReliabilityInput(input: ReliabilityInput): void {
  if (!getScenario(input.scenario) && !input.fault) {
    throw new ConfigError(
      "SW_CONFIG_RELIABILITY",
      `reliability.scenario: Unknown scenario "${input.scenario}"`,
      {
        hint: "Run `sw reliability list` for the catalogue, or pass a custom `fault`",
      },
    );
  }
  const total = input.repeat * (input.steady + input.duration + input.recovery);
  if (total > input.maxDuration) {
    throw new ConfigError(
      "SW_CONFIG_RELIABILITY",
      `reliability: experiment needs ${total} ms (repeat × (steady + duration + recovery)) > maxDuration ${input.maxDuration} ms`,
    );
  }
  for (const key of ["steadyState", "hypothesis"] as const) {
    for (const [i, e] of input[key].entries()) {
      let t: ReturnType<typeof parseThreshold>;
      try {
        t = parseThreshold(e);
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        throw new ConfigError("SW_CONFIG_RELIABILITY", `reliability.${key}[${i}]: ${err.message}`, {
          ...(err.hint !== undefined ? { hint: err.hint } : {}),
        });
      }
      if (t.scope !== "http" && !t.scope.startsWith("scenario.")) {
        throw new ConfigError(
          "SW_CONFIG_RELIABILITY",
          `reliability.${key}[${i}]: scope must be http or scenario.<route> ("${e}")`,
        );
      }
    }
  }
}

/**
 * Runs a reliability experiment standalone. Missing context members get test-friendly defaults —
 * note the default safety guard is non-interactive without approval, so pass a `safety` created with
 * `{ approve: true }` (or `approveDisruptive: true`) to allow fault injection.
 */
export async function runReliability(
  input: ReliabilityInputLoose,
  ctx?: Partial<EngineContext>,
  deps?: ReliabilityDeps,
): Promise<EngineResult<ReliabilityData>> {
  const parsed = parseReliabilityInput(input);
  return executeReliability(parsed, createEngineContext(ctx ?? {}), deps);
}
