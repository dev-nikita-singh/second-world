/**
 * ULID identifiers — docs/04-data-structures-and-algorithms.md §9.2.
 * 48-bit ms timestamp + 80-bit randomness, lexicographically sortable, monotonic within a ms.
 */
import { decodeTime, isValid, monotonicFactory, type ULIDFactory } from "ulid";

/** A monotonic ULID generator. `prng` (returns [0,1)) may be injected for determinism. */
export function createUlidFactory(prng?: () => number): (timeMs?: number) => string {
  const f: ULIDFactory = prng ? monotonicFactory(prng) : monotonicFactory();
  return (timeMs?: number) => f(timeMs);
}

const defaultFactory = createUlidFactory();

/** New monotonic ULID (process-wide factory). */
export function ulid(timeMs?: number): string {
  return defaultFactory(timeMs);
}

export function isUlid(s: string): boolean {
  return isValid(s);
}

/** Millisecond timestamp encoded in a ULID. */
export function ulidTime(id: string): number {
  return decodeTime(id);
}
