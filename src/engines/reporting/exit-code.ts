/**
 * Exit codes for a completed run. docs/03-engines/evidence-and-history.md §A.6.
 *
 * Only the codes a *finished* run can produce are decided here:
 *   130 cancelled > 70 engine error > 1 failures (thresholds / findings ≥ failOn) > 0.
 * 2/3/4/5 (config / safety / capability / target) come from SecondWorldError.exitCode
 * thrown before or instead of a result; see `exitCodeForError`.
 */
import { ExitCode, isSecondWorldError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import { computeVerdict, DEFAULT_FAIL_ON, type FailOn } from "./model.js";

export const FAIL_ON_VALUES: readonly FailOn[] = ["critical", "high", "medium", "low", "never"];

export function isFailOn(x: unknown): x is FailOn {
  return typeof x === "string" && (FAIL_ON_VALUES as readonly string[]).includes(x);
}

/** Exit code for a set of engine results at the given `--fail-on` level. */
export function computeExitCode(
  results: readonly EngineResult[],
  failOn: FailOn = DEFAULT_FAIL_ON,
): ExitCode {
  return computeVerdict(results, failOn).exitCode;
}

/** Exit code for an error thrown instead of a result (70 for anything unknown). */
export function exitCodeForError(err: unknown): ExitCode {
  return isSecondWorldError(err) ? err.exitCode : ExitCode.Internal;
}
