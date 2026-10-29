/**
 * IPOG pairwise (2-way) combinatorial test generation with constraints.
 * docs/04-data-structures-and-algorithms.md §7.3.
 *
 * Parameters are given by their number of values; rows are arrays of value indices.
 * A constraint receives a partial row (undefined = not yet assigned) and returns false when
 * the assigned values are an invalid combination. Pairs that are infeasible on their own are
 * never required. Iterative, O(rows · params · values) per parameter.
 */

export type PartialRow = (number | undefined)[];

export interface IpogOptions {
  /** Returns false if the (partial) assignment is invalid. */
  constraint?: (row: PartialRow) => boolean;
}

function pairFeasible(
  n: number,
  j: number,
  vj: number,
  i: number,
  vi: number,
  c?: IpogOptions["constraint"],
): boolean {
  if (!c) return true;
  const r: PartialRow = new Array(n).fill(undefined);
  r[j] = vj;
  r[i] = vi;
  return c(r);
}

/** Generates a covering array of strength 2. Returns rows of value indices (one per parameter). */
export function ipog(sizes: readonly number[], opts: IpogOptions = {}): number[][] {
  const n = sizes.length;
  const c = opts.constraint;
  if (n === 0) return [];
  if (sizes.some((s) => s <= 0)) return [];
  const ok = (r: PartialRow): boolean =>
    c ? c(r.length === n ? r : [...r, ...new Array(n - r.length).fill(undefined)]) : true;
  if (n === 1) {
    const out: number[][] = [];
    for (let v = 0; v < (sizes[0] ?? 0); v++) if (ok([v])) out.push([v]);
    return out;
  }
  // Rows of the first two params: all feasible combos.
  let rows: PartialRow[] = [];
  for (let a = 0; a < (sizes[0] ?? 0); a++) {
    for (let b = 0; b < (sizes[1] ?? 0); b++) {
      if (ok([a, b])) rows.push([a, b]);
    }
  }
  for (let i = 2; i < n; i++) {
    const si = sizes[i] ?? 0;
    // uncovered[j][vj * si + vi]
    const uncovered: Uint8Array[] = [];
    let remaining = 0;
    for (let j = 0; j < i; j++) {
      const sj = sizes[j] ?? 0;
      const u = new Uint8Array(sj * si);
      for (let vj = 0; vj < sj; vj++) {
        for (let vi = 0; vi < si; vi++) {
          if (pairFeasible(n, j, vj, i, vi, c)) {
            u[vj * si + vi] = 1;
            remaining++;
          }
        }
      }
      uncovered.push(u);
    }
    const cover = (row: PartialRow, vi: number, apply: boolean): number => {
      let gain = 0;
      for (let j = 0; j < i; j++) {
        const vj = row[j];
        if (vj === undefined) continue;
        const u = uncovered[j] as Uint8Array;
        const k = vj * si + vi;
        if (u[k] === 1) {
          gain++;
          if (apply) {
            u[k] = 0;
            remaining--;
          }
        }
      }
      return gain;
    };
    // Horizontal growth.
    for (const row of rows) {
      let best = -1;
      let bestGain = -1;
      for (let vi = 0; vi < si; vi++) {
        row[i] = vi;
        if (!ok(row)) continue;
        const g = cover(row, vi, false);
        if (g > bestGain) {
          bestGain = g;
          best = vi;
        }
      }
      if (best < 0) row[i] = undefined;
      else {
        row[i] = best;
        cover(row, best, true);
      }
    }
    // Vertical growth.
    const added: PartialRow[] = [];
    if (remaining > 0) {
      for (let j = 0; j < i; j++) {
        const sj = sizes[j] ?? 0;
        const u = uncovered[j] as Uint8Array;
        for (let vj = 0; vj < sj; vj++) {
          for (let vi = 0; vi < si; vi++) {
            if (u[vj * si + vi] !== 1) continue;
            let placed = false;
            for (const r of rows.length + added.length > 0 ? [...rows, ...added] : []) {
              if (r[i] === vi && r[j] === undefined) {
                r[j] = vj;
                if (ok(r)) {
                  cover(r, vi, true);
                  placed = true;
                  break;
                }
                r[j] = undefined;
              }
            }
            if (!placed) {
              const r: PartialRow = new Array(i + 1).fill(undefined);
              r[j] = vj;
              r[i] = vi;
              cover(r, vi, true);
              added.push(r);
            }
          }
        }
      }
    }
    rows = rows.concat(added);
  }
  // Fill don't-care positions with any value satisfying the constraint.
  const out: number[][] = [];
  for (const row of rows) {
    let valid = true;
    for (let p = 0; p < n; p++) {
      if (row[p] !== undefined) continue;
      let filled = false;
      for (let v = 0; v < (sizes[p] ?? 0); v++) {
        row[p] = v;
        if (ok(row)) {
          filled = true;
          break;
        }
      }
      if (!filled) {
        valid = false;
        break;
      }
    }
    if (valid && ok(row)) out.push(row as number[]);
  }
  return out;
}

/** All feasible pairs not covered by `rows` (for tests/diagnostics). */
export function uncoveredPairs(
  sizes: readonly number[],
  rows: readonly (readonly number[])[],
  constraint?: IpogOptions["constraint"],
): [number, number, number, number][] {
  const n = sizes.length;
  const missing: [number, number, number, number][] = [];
  for (let j = 0; j < n; j++) {
    for (let i = j + 1; i < n; i++) {
      for (let vj = 0; vj < (sizes[j] ?? 0); vj++) {
        for (let vi = 0; vi < (sizes[i] ?? 0); vi++) {
          if (!pairFeasible(n, j, vj, i, vi, constraint)) continue;
          if (!rows.some((r) => r[j] === vj && r[i] === vi)) missing.push([j, vj, i, vi]);
        }
      }
    }
  }
  return missing;
}
