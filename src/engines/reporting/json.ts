/**
 * Canonical JSON report + crash-safe atomic file writes.
 * docs/03-engines/evidence-and-history.md §A.5 (JSON: canonical, schema-versioned)
 * and §B.1 (write temp, then rename).
 * The atomic writer lives in src/shared/util/atomic-write.ts (also used by model and architecture).
 */

import { writeFileAtomic } from "../../shared/util/atomic-write.js";
import type { CombinedReport } from "./model.js";

export { type AtomicWriteOptions, writeFileAtomic } from "../../shared/util/atomic-write.js";

/** Serialise a report as canonical JSON (2-space indent, trailing newline). */
export function renderJson(report: CombinedReport): string {
  return `${JSON.stringify(report, jsonReplacer, 2)}\n`;
}

/** Drop `undefined`, turn non-finite numbers into null, BigInt into string. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

export async function writeJsonReport(file: string, report: CombinedReport): Promise<void> {
  await writeFileAtomic(file, renderJson(report));
}
