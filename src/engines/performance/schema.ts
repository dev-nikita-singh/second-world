/**
 * Performance Lab input schema. See docs/03-engines/performance-lab.md §3 and
 * docs/08-configuration.md §3 (performance block) / §4 (threshold grammar).
 *
 * Durations accept strings ("30s", "1h30m") or numbers (ms) and are normalised to ms.
 * The workload model is inferred when omitted: `rate` → open, `iterations` → iterations, else closed.
 */
import { z } from "zod";
import { parseDuration } from "../../core/config/units.js";

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

const HttpMethod = z
  .string()
  .transform((s) => s.toUpperCase())
  .pipe(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]));

const ExpectSchema = z
  .object({
    status: z
      .union([z.number().int().min(100).max(599), z.array(z.number().int().min(100).max(599)).min(1)])
      .optional(),
    /** Substring that must appear in the response body. */
    bodyContains: z.string().optional(),
  })
  .strict();

export const StepSchema = z
  .object({
    name: z.string().optional(),
    method: HttpMethod.default("GET"),
    /** Path relative to `target` (may contain `{{templates}}`), or an absolute URL on an allowed host. */
    path: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    json: z.unknown().optional(),
    body: z.string().optional(),
    expect: ExpectSchema.optional(),
    /** Follow 3xx redirects (up to 5 hops); every hop is vetted by the Safety Guard. Default false. */
    followRedirects: z.boolean().default(false),
    /** `{ var: "$.json.path" | "header:x-name" | "regex:<pattern>" }` */
    extract: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().min(1)).default({}),
  })
  .strict()
  .refine((s) => !(s.json !== undefined && s.body !== undefined), {
    message: "use either `json` or `body`, not both",
  });

const AuthSchema = z.union([
  z.object({ type: z.literal("bearer"), token: z.string() }).strict(),
  z.object({ type: z.literal("basic"), username: z.string(), password: z.string() }).strict(),
  z.object({ type: z.literal("header"), name: z.string(), value: z.string() }).strict(),
]);

/**
 * Auth on a scenario or the section: a resolved credential object, or a role name from
 * `config.auth` that the world (`buildPerformanceInput`) resolves before the engine runs.
 */
const AuthRefSchema = z.union([z.string().min(1), AuthSchema]);

export const ScenarioSchema = z
  .object({
    name: z.string().min(1),
    weight: z.number().positive().default(1),
    /** Overrides section-level `auth` for this scenario's steps (explicit step headers still win). */
    auth: AuthRefSchema.optional(),
    steps: z.array(StepSchema).min(1),
  })
  .strict();

const ThinkTimeSchema = z.union([
  Duration,
  z.object({ min: Duration, max: Duration }).strict(),
  z.object({ dist: z.literal("exp"), mean: Duration }).strict(),
]);

const ThresholdValue = z.union([
  z.string(),
  z
    .object({
      expr: z.string(),
      abortOnFail: z.boolean().optional(),
      delayAbortEval: z.union([z.string(), z.number()]).optional(),
    })
    .strict(),
]);

const DataSchema = z
  .object({
    /** Inline rows (useful in code and tests). */
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))).optional(),
    /** CSV / JSON (array) / JSONL file. */
    file: z.string().optional(),
    mode: z.enum(["sequential", "random", "unique"]).default("sequential"),
  })
  .strict()
  .refine((d) => d.rows !== undefined || d.file !== undefined, { message: "data needs `rows` or `file`" });

export const PerformanceInputSchema = z
  .object({
    target: z.url({ protocol: /^https?$/ }),
    allowHosts: z.array(z.string()).default([]),
    model: z.enum(["closed", "open", "iterations"]).optional(),
    vus: z.number().int().positive().max(100_000).optional(),
    rate: z.number().positive().max(1_000_000).optional(),
    arrival: z.enum(["constant", "poisson"]).default("constant"),
    iterations: z.number().int().positive().optional(),
    /** Default 10s (closed/open) or 10m max (iterations). Includes rampUp; warmup runs before it. */
    duration: Duration.optional(),
    rampUp: Duration.default(0),
    warmup: Duration.default(0),
    /** Internal: warm-up requested for the iterations model, which does not use it (set by the transform). */
    warmupIgnoredMs: z.number().nonnegative().optional(),
    gracefulStop: Duration.default(5_000),
    timeout: Duration.default(10_000),
    connectTimeout: Duration.default(5_000),
    thinkTime: ThinkTimeSchema.default(0),
    /** Safety cap on concurrent requests in the open model; arrivals beyond it are counted as `dropped`. */
    maxInFlight: z.number().int().positive().optional(),
    scenarios: z.array(ScenarioSchema).default([]),
    data: DataSchema.optional(),
    auth: AuthRefSchema.optional(),
    thresholds: z.record(z.string(), z.union([ThresholdValue, z.array(ThresholdValue)])).default({}),
    budget: z
      .object({
        maxRequests: z.number().int().positive().optional(),
        maxRps: z.number().positive().optional(),
        maxDuration: Duration.optional(),
        maxBytes: z.number().int().positive().optional(),
      })
      .strict()
      .default({}),
    http: z
      .object({
        version: z.enum(["1.1", "2"]).default("1.1"),
        connections: z.number().int().positive().max(100_000).optional(),
        keepAlive: z.boolean().default(true),
        pipelining: z.number().int().min(1).max(128).default(1),
      })
      .strict()
      .default({ version: "1.1", keepAlive: true, pipelining: 1 }),
    workers: z.union([z.number().int().positive(), z.literal("auto")]).default(1),
    seed: z.number().int().optional(),
    timing: z.enum(["basic", "detailed"]).default("basic"),
    /** Per-step 'expect' default when none given: status < 400 is success. */
  })
  .strict()
  .superRefine((v, ctx) => {
    const model = v.model ?? inferModel(v);
    if (model === "open" && v.rate === undefined) {
      ctx.addIssue({ code: "custom", path: ["rate"], message: 'model "open" requires `rate` (requests/s)' });
    }
    if (model === "iterations" && v.iterations === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["iterations"],
        message: 'model "iterations" requires `iterations`',
      });
    }
    if (v.rampUp > v.warmup + (v.duration ?? (model === "iterations" ? 600_000 : 10_000))) {
      ctx.addIssue({ code: "custom", path: ["rampUp"], message: "rampUp must not exceed warmup + duration" });
    }
    if (v.budget.maxRps !== undefined && v.rate !== undefined && v.rate > v.budget.maxRps) {
      ctx.addIssue({
        code: "custom",
        path: ["rate"],
        message: `rate ${v.rate}/s exceeds budget.maxRps ${v.budget.maxRps}`,
      });
    }
  })
  .transform((v) => {
    const model = v.model ?? inferModel(v);
    let scenarios = v.scenarios;
    if (scenarios.length === 0) {
      const u = new URL(v.target);
      scenarios = [
        {
          name: "default",
          weight: 1,
          steps: [
            {
              method: "GET",
              path: `${u.pathname}${u.search}`,
              headers: {},
              query: {},
              extract: {},
              followRedirects: false,
            },
          ],
        },
      ];
    }
    const vus = v.vus ?? (model === "open" ? undefined : 10);
    const duration = v.duration ?? (model === "iterations" ? 600_000 : 10_000);
    // Iterations are the workload: a time-based warm-up would consume them unmeasured.
    if (model === "iterations" && v.warmup > 0) {
      return { ...v, model, vus, scenarios, duration, warmup: 0, warmupIgnoredMs: v.warmup };
    }
    return { ...v, model, vus, scenarios, duration };
  });

function inferModel(v: {
  rate?: number | undefined;
  iterations?: number | undefined;
}): "open" | "closed" | "iterations" {
  if (v.rate !== undefined) return "open";
  if (v.iterations !== undefined) return "iterations";
  return "closed";
}

export type PerformanceInput = z.output<typeof PerformanceInputSchema>;
export type PerformanceInputLoose = z.input<typeof PerformanceInputSchema>;
export type PerformanceStep = z.output<typeof StepSchema>;
export type PerformanceScenario = z.output<typeof ScenarioSchema>;
export type ThinkTime = z.output<typeof ThinkTimeSchema>;
