/**
 * Delta debugging (ddmin, Zeller & Hildebrandt) for failing request sequences.
 * docs/04-data-structures-and-algorithms.md §7.4.
 *
 * `fails(subset)` must return true when the subset still reproduces the failure (each call is
 * typically a full replay against a reset environment). Results are memoised by index set and
 * the number of tests is capped by `maxTests`. Without hitting the cap the result is 1-minimal:
 * removing any single element makes the failure disappear.
 */

export interface DdminOptions {
  /** Maximum number of `fails` invocations (replay budget). Default 200. */
  maxTests?: number;
}

export interface DdminResult<T> {
  result: T[];
  /** Indices (into the input) of the kept elements, ascending. */
  indices: number[];
  tests: number;
  /** True when the budget ran out (result is failing but maybe not 1-minimal). */
  exhausted: boolean;
}

function split(idx: number[], n: number): number[][] {
  const out: number[][] = [];
  let start = 0;
  for (let k = 0; k < n; k++) {
    const end = start + Math.floor((idx.length - start) / (n - k));
    out.push(idx.slice(start, end));
    start = end;
  }
  return out.filter((c) => c.length > 0);
}

export async function ddmin<T>(
  input: readonly T[],
  fails: (subset: T[]) => boolean | Promise<boolean>,
  opts: DdminOptions = {},
): Promise<DdminResult<T>> {
  const maxTests = opts.maxTests ?? 200;
  const memo = new Map<string, boolean>();
  let tests = 0;
  let exhausted = false;
  const test = async (idx: number[]): Promise<boolean> => {
    const key = idx.join(",");
    const m = memo.get(key);
    if (m !== undefined) return m;
    if (tests >= maxTests) {
      exhausted = true;
      return false;
    }
    tests++;
    const r = await fails(idx.map((i) => input[i] as T));
    memo.set(key, r);
    return r;
  };
  let current = input.map((_, i) => i);
  let n = 2;
  while (current.length >= 2) {
    const chunks = split(current, Math.min(n, current.length));
    let reduced = false;
    // Reduce to subset.
    for (const c of chunks) {
      if (await test(c)) {
        current = c;
        n = 2;
        reduced = true;
        break;
      }
    }
    if (!reduced && chunks.length > 2) {
      // Reduce to complement.
      for (const c of chunks) {
        const cs = new Set(c);
        const comp = current.filter((i) => !cs.has(i));
        if (await test(comp)) {
          current = comp;
          n = Math.max(n - 1, 2);
          reduced = true;
          break;
        }
      }
    } else if (!reduced && chunks.length === 2) {
      // With two chunks the complements are the chunks themselves (already tested).
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(current.length, n * 2);
    }
    if (exhausted) break;
  }
  return { result: current.map((i) => input[i] as T), indices: current, tests, exhausted };
}
