/**
 * Stable fingerprints for findings / error dedup — docs/04-data-structures-and-algorithms.md §9.1, §4.5.
 * fingerprint = first 16 hex chars of sha256(normalised parts joined by "|").
 * Normalisation: trim, collapse whitespace, lower-case; "\" and "|" inside parts are escaped
 * so ["a|b"] and ["a","b"] differ.
 */
import { sha256 } from "./hash.js";

export function normalizePart(part: string): string {
  return part.trim().replace(/\s+/g, " ").toLowerCase().replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

export function fingerprint(parts: readonly (string | number | boolean | null | undefined)[]): string {
  const joined = parts.map((p) => normalizePart(p === null || p === undefined ? "" : String(p))).join("|");
  return sha256(joined).slice(0, 16);
}
