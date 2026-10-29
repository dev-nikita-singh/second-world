/**
 * Stage planner (pure). See docs/03-engines/stress-capacity-lab.md §1 (experiment types) and §3.5
 * (binary-search refinement for breakpoint mode).
 */
import type { StressInput } from "./schema.js";

export type StageKind =
  | "step"
  | "ramp"
  | "spike-before"
  | "spike-peak"
  | "spike-after"
  | "soak"
  | "breakpoint"
  | "bisect";

export interface PlannedStage {
  index: number;
  kind: StageKind;
  label: string;
  /** VUs (integer) or requests/s. */
  level: number;
  holdMs: number;
  settleMs: number;
}

type PlanInput = Pick<
  StressInput,
  "mode" | "loadType" | "stages" | "range" | "hold" | "settle" | "breakpoint" | "ramp" | "spike" | "soak"
>;

/** Rounds a level for the load dimension: VUs are integers ≥ 1, rates keep 2 decimals. */
export function normalizeLevel(level: number, loadType: "vus" | "rate"): number {
  if (loadType === "vus") return Math.max(1, Math.round(level));
  return Math.max(0.01, Math.round(level * 100) / 100);
}

/** Ascending, de-duplicated levels from..to by step (to is always included). Iterative, bounded. */
export function rangeLevels(
  from: number,
  to: number,
  step: number,
  loadType: "vus" | "rate",
  max = 500,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    const v = from + i * step;
    if (v > to + 1e-9) break;
    out.push(normalizeLevel(v, loadType));
  }
  const last = normalizeLevel(to, loadType);
  if (out.length < max && (out.length === 0 || (out[out.length - 1] as number) < last)) out.push(last);
  return dedupeSorted(out);
}

function dedupeSorted(levels: number[]): number[] {
  const s = [...levels].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  return out;
}

/**
 * Static stage plan. For breakpoint mode this is the coarse ladder; bisection stages are added at run
 * time with {@link nextBisectionLevel}.
 */
export function planStages(input: PlanInput, maxStages = 500): PlannedStage[] {
  const lt = input.loadType;
  const mk = (
    kind: StageKind,
    level: number,
    holdMs: number,
    settleMs: number,
    label?: string,
  ): PlannedStage => ({
    index: 0,
    kind,
    label: label ?? `${kind} ${level} ${lt === "vus" ? "VUs" : "rps"}`,
    level,
    holdMs,
    settleMs,
  });
  let stages: PlannedStage[] = [];
  switch (input.mode) {
    case "step": {
      const levels = input.stages
        ? dedupeSorted(input.stages.map((l) => normalizeLevel(l, lt)))
        : input.range
          ? rangeLevels(input.range.from, input.range.to, input.range.step, lt, maxStages)
          : [];
      stages = levels.map((l) => mk("step", l, input.hold, input.settle));
      break;
    }
    case "ramp": {
      const r = input.ramp;
      if (!r) break;
      const n = r.stages;
      const hold = Math.max(1, Math.floor(r.duration / n));
      const raw: number[] = [];
      for (let i = 0; i < n; i++) raw.push(normalizeLevel(r.from + ((r.to - r.from) * i) / (n - 1), lt));
      // Merge consecutive equal levels (integer rounding) by adding their hold time.
      for (const l of raw) {
        const last = stages[stages.length - 1];
        if (last && last.level === l) last.holdMs += hold;
        else stages.push(mk("ramp", l, hold, 0));
      }
      if (stages[0]) stages[0].settleMs = input.settle;
      break;
    }
    case "spike": {
      const s = input.spike;
      if (!s) break;
      const before = s.before ?? input.hold;
      const after = s.after ?? Math.max(input.hold, 3 * s.duration);
      const b = normalizeLevel(s.baseline, lt);
      const p = normalizeLevel(s.peak, lt);
      stages = [
        mk("spike-before", b, before, input.settle, `baseline ${b}`),
        mk("spike-peak", p, s.duration, 0, `spike ${p}`),
        mk("spike-after", b, after, 0, `recovery ${b}`),
      ];
      break;
    }
    case "soak": {
      const s = input.soak;
      if (!s) break;
      stages = [mk("soak", normalizeLevel(s.level, lt), s.duration, input.settle)];
      break;
    }
    case "breakpoint": {
      const b = input.breakpoint;
      if (!b) break;
      stages = rangeLevels(b.from, b.to, b.step, lt, maxStages).map((l) =>
        mk("breakpoint", l, input.hold, input.settle),
      );
      break;
    }
  }
  stages = stages.slice(0, maxStages);
  stages.forEach((s, i) => {
    s.index = i;
  });
  return stages;
}

/** Default minimum bisection step: step/4, at least 1 VU (or 0.01 rps). */
export function defaultMinStep(step: number, loadType: "vus" | "rate"): number {
  return loadType === "vus" ? Math.max(1, Math.round(step / 4)) : Math.max(0.01, step / 4);
}

/**
 * Next level to probe between the last passing and first failing load, or null when the gap is
 * ≤ minStep (converged) or no distinct level fits. Converges in ⌈log2((fail − pass)/minStep)⌉ steps.
 */
export function nextBisectionLevel(
  lastPass: number,
  firstFail: number,
  minStep: number,
  loadType: "vus" | "rate",
): number | null {
  if (!(firstFail > lastPass)) return null;
  if (firstFail - lastPass <= minStep + 1e-9) return null;
  const mid = normalizeLevel((lastPass + firstFail) / 2, loadType);
  if (mid <= lastPass || mid >= firstFail) return null;
  return mid;
}
