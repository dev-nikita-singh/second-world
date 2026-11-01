/**
 * Stress & Capacity Lab input. See docs/03-engines/stress-capacity-lab.md §1–§2, §5.
 *
 * A stress input is a Performance Lab input (docs/03-engines/performance-lab.md §3, the "base")
 * plus stress-specific keys. The base is validated by PerformanceInputSchema for a representative
 * stage; per stage the runner overrides `model`, `vus`/`rate`, `duration`, `warmup`, `rampUp`.
 */
import { z } from "zod";
import { parseDuration } from "../../core/config/units.js";
import { PerformanceInputSchema } from "../performance/schema.js";

const Duration = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return parseDuration(v);
  } catch (e) {
    ctx.addIssue({
      code: "custom",
      message: e instanceof Error ? e.message : `invalid duration ${String(v)}`,
    });
    return z.NEVER;
  }
});

const Level = z.number().positive();

const RangeSchema = z
  .object({ from: Level, to: Level, step: Level })
  .strict()
  .refine((r) => r.to >= r.from, { message: "`to` must be >= `from`" });

export const StressModeSchema = z.enum(["step", "ramp", "spike", "soak", "breakpoint"]);
export type StressMode = z.infer<typeof StressModeSchema>;

export const STRESS_KEYS = [
  "mode",
  "loadType",
  "stages",
  "range",
  "hold",
  "settle",
  "isolateStages",
  "stopWhen",
  "breakpoint",
  "spike",
  "soak",
  "ramp",
  "limits",
  "usl",
] as const;

const StressFieldsSchema = z.object({
  mode: StressModeSchema.default("step"),
  /** Load dimension: VUs (closed model) or arrival rate (open model). Inferred from the base when omitted. */
  loadType: z.enum(["vus", "rate"]).optional(),
  /** Step mode: explicit levels (sorted ascending, de-duplicated). */
  stages: z.array(Level).min(1).optional(),
  /** Step mode alternative: from..to by step. */
  range: RangeSchema.optional(),
  /** Measured hold per stage. Default 30 s. */
  hold: Duration.default(30_000),
  /** Settle period at the new level before measuring (excluded from metrics). Default 0. */
  settle: Duration.default(0),
  /** true: every stage gets fresh connections. false (default): stages share one connection pool. */
  isolateStages: z.boolean().default(false),
  stopWhen: z
    .object({
      /** Hard stop when a stage's error rate exceeds this (0..1). Default 0.5. */
      errorRate: z.number().min(0).max(1).default(0.5),
      /** Abort a stage once window-level thresholds fail this many consecutive 1 s windows (0 = off). Default 5. */
      consecutiveWindows: z.number().int().min(0).default(5),
      /** Stop the sequence at the first stage that breaches a threshold. Default true (ignored for spike/soak). */
      onBreach: z.boolean().default(true),
      /** Stages to still run after the first breach when onBreach is true. Default 0. */
      continueAfterBreach: z.number().int().min(0).default(0),
      /** Stop when the generator is saturated. Default true. */
      onSaturation: z.boolean().default(true),
    })
    .strict()
    .default({
      errorRate: 0.5,
      consecutiveWindows: 5,
      onBreach: true,
      continueAfterBreach: 0,
      onSaturation: true,
    }),
  breakpoint: z
    .object({
      from: Level,
      to: Level,
      step: Level,
      /** Bisection stops when last-pass/first-fail are closer than this. Default step/4 (1 for VUs at least). */
      minStep: Level.optional(),
    })
    .strict()
    .refine((r) => r.to >= r.from, { message: "`to` must be >= `from`" })
    .optional(),
  ramp: z
    .object({
      from: Level,
      to: Level,
      duration: Duration,
      /** Number of discrete stages the ramp is cut into. Default 10. */
      stages: z.number().int().min(2).max(200).default(10),
    })
    .strict()
    .optional(),
  spike: z
    .object({
      baseline: Level,
      peak: Level,
      /** Spike duration. Default 10 s. */
      duration: Duration.default(10_000),
      /** Pre-spike baseline hold. Default: `hold`. */
      before: Duration.optional(),
      /** Post-spike observation (recovery). Default: max(hold, 3 × duration). */
      after: Duration.optional(),
    })
    .strict()
    .optional(),
  soak: z
    .object({
      level: Level,
      duration: Duration,
      /** Aggregation window for drift analysis. Default 10 s. */
      window: Duration.default(10_000),
    })
    .strict()
    .optional(),
  /** Whole-experiment limits (on top of the safety guard). */
  limits: z
    .object({
      maxDuration: Duration.optional(),
      maxRequests: z.number().int().positive().optional(),
      maxStages: z.number().int().positive().max(500).default(50),
    })
    .strict()
    .default({ maxStages: 50 }),
  /** Fit the Universal Scalability Law (estimate). Default true (refused when < 5 stages or R² < 0.9). */
  usl: z.boolean().default(true),
});

export const StressInputSchema = StressFieldsSchema.catchall(z.unknown())
  .superRefine((v, ctx) => {
    const need = (key: keyof typeof v, mode: StressMode): void => {
      if (v.mode === mode && v[key] === undefined)
        ctx.addIssue({
          code: "custom",
          path: [key as string],
          message: `mode "${mode}" requires \`${String(key)}\``,
        });
    };
    if (v.mode === "step" && v.stages === undefined && v.range === undefined) {
      ctx.addIssue({ code: "custom", path: ["stages"], message: 'mode "step" requires `stages` or `range`' });
    }
    need("breakpoint", "breakpoint");
    need("ramp", "ramp");
    need("spike", "spike");
    need("soak", "soak");
    if (v.spike && v.spike.peak <= v.spike.baseline) {
      ctx.addIssue({
        code: "custom",
        path: ["spike", "peak"],
        message: "spike.peak must be > spike.baseline",
      });
    }
    // Validate the base with a representative stage.
    const { base, loadType } = splitBase(v as Record<string, unknown>);
    const probe = stagePerfInput(base, loadType, 1, 1000, 0, 0);
    const r = PerformanceInputSchema.safeParse(probe);
    if (!r.success) {
      for (const i of r.error.issues) {
        if (i.path[0] === "vus" || i.path[0] === "rate" || i.path[0] === "duration") continue;
        ctx.addIssue({ code: "custom", path: i.path as (string | number)[], message: i.message });
      }
    }
  })
  .transform((v) => {
    const { base, loadType } = splitBase(v as Record<string, unknown>);
    const fields = Object.fromEntries(
      STRESS_KEYS.map((k) => [k, (v as Record<string, unknown>)[k]]),
    ) as z.output<typeof StressFieldsSchema>;
    return { ...fields, loadType, base };
  });

export type StressInput = z.output<typeof StressInputSchema>;
export type StressInputLoose = z.input<typeof StressFieldsSchema> & Record<string, unknown>;

function splitBase(v: Record<string, unknown>): { base: Record<string, unknown>; loadType: "vus" | "rate" } {
  const base: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!(STRESS_KEYS as readonly string[]).includes(k)) base[k] = val;
  }
  let loadType = v.loadType as "vus" | "rate" | undefined;
  // Same rule as performance's model inference: an explicit model wins, else a rate means open.
  if (loadType === undefined) {
    if (base.model === "open") loadType = "rate";
    else if (base.model === "closed" || base.model === "iterations") loadType = "vus";
    else loadType = base.rate !== undefined ? "rate" : "vus";
  }
  return { base, loadType };
}

/**
 * Performance input for one stage: base + level. Strips base load/timing keys that the stage owns.
 * `extraWarmupMs` (base warm-up) is only given to the first stage.
 */
export function stagePerfInput(
  base: Record<string, unknown>,
  loadType: "vus" | "rate",
  level: number,
  holdMs: number,
  settleMs: number,
  extraWarmupMs: number,
  seedOffset = 0,
): Record<string, unknown> {
  const {
    vus: _v,
    rate: _r,
    model: _m,
    duration: _d,
    warmup: _w,
    rampUp: _ru,
    iterations: _it,
    ...rest
  } = base;
  const out: Record<string, unknown> = {
    ...rest,
    model: loadType === "vus" ? "closed" : "open",
    duration: holdMs,
    warmup: settleMs + extraWarmupMs,
    rampUp: 0,
  };
  if (loadType === "vus") out.vus = Math.max(1, Math.round(level));
  else out.rate = level;
  if (typeof base.seed === "number") out.seed = base.seed + seedOffset;
  // Stage transitions must be quick: a long drain hides spike recovery and wastes time.
  if (base.gracefulStop === undefined) out.gracefulStop = 1_000;
  return out;
}
