/**
 * Pareto ranking of candidates. docs/04-data-structures-and-algorithms.md §8.3 and
 * docs/03-engines/experiments.md §B.4.
 * After orienting every metric "higher is better", c dominates d iff c ≥ d on all metrics and > on
 * at least one. O(c²·m). Non-dominated sorting assigns layer 1 (the front), 2, …; within a layer,
 * ties are broken by the weighted score (desc), then diff size (asc), then the observed
 * (not significance-filtered) weighted change (desc), then name.
 */
export interface ParetoItem {
  name: string;
  /** Oriented values (higher is better), one per metric. NaN is treated as worst. */
  values: readonly number[];
  /** Weighted score for tie-breaks (higher is better). */
  score?: number;
  /** Diff size in changed lines (smaller is better). */
  diffSize?: number;
  /** Observed weighted change before significance filtering (higher is better); last tie-break before the name. */
  observed?: number;
}

function val(x: number | undefined): number {
  return x === undefined || Number.isNaN(x) ? Number.NEGATIVE_INFINITY : x;
}

export function dominates(a: readonly number[], b: readonly number[]): boolean {
  let strictly = false;
  const m = Math.max(a.length, b.length);
  for (let i = 0; i < m; i++) {
    const x = val(a[i]);
    const y = val(b[i]);
    if (x < y) return false;
    if (x > y) strictly = true;
  }
  return strictly;
}

/** Indexes of non-dominated items (input order). */
export function paretoFront(items: readonly Pick<ParetoItem, "values">[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < items.length; i++) {
    let dominated = false;
    for (let j = 0; j < items.length && !dominated; j++) {
      if (i !== j && dominates((items[j] as ParetoItem).values, (items[i] as ParetoItem).values))
        dominated = true;
    }
    if (!dominated) out.push(i);
  }
  return out;
}

export interface RankedItem {
  name: string;
  /** 1 = Pareto front. */
  layer: number;
  /** 1-based overall rank. */
  rank: number;
  dominatedBy: string[];
}

function tieBreak(a: ParetoItem, b: ParetoItem): number {
  const s = (b.score ?? 0) - (a.score ?? 0);
  if (s !== 0 && Number.isFinite(s)) return s;
  const d = (a.diffSize ?? 0) - (b.diffSize ?? 0);
  if (d !== 0) return d;
  const o = (b.observed ?? 0) - (a.observed ?? 0);
  if (o !== 0 && Number.isFinite(o)) return o;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Non-dominated sorting + tie-breaks. Returns items in rank order. */
export function rankPareto(items: readonly ParetoItem[]): RankedItem[] {
  const remaining = items.map((_, i) => i);
  const out: RankedItem[] = [];
  let layer = 1;
  while (remaining.length > 0) {
    const sub = remaining.map((i) => items[i] as ParetoItem);
    const frontLocal = paretoFront(sub);
    const front = frontLocal.map((k) => remaining[k] as number);
    front.sort((x, y) => tieBreak(items[x] as ParetoItem, items[y] as ParetoItem));
    for (const i of front) {
      const it = items[i] as ParetoItem;
      out.push({
        name: it.name,
        layer,
        rank: out.length + 1,
        dominatedBy: items.filter((o, j) => j !== i && dominates(o.values, it.values)).map((o) => o.name),
      });
    }
    const inFront = new Set(front);
    for (let k = remaining.length - 1; k >= 0; k--)
      if (inFront.has(remaining[k] as number)) remaining.splice(k, 1);
    layer++;
  }
  return out;
}
