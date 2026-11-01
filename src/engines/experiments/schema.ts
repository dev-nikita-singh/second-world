/**
 * What-If experiment and Evolution input schemas. docs/03-engines/experiments.md §A.2, §A.3, §B.2–B.6.
 *
 * Durations accept "30s"/"250ms"/numbers (ms) and are normalised to ms.
 * Commands are argv arrays or strings split without a shell (see command.ts).
 */

import { z } from "zod";
import { zodIssueLines } from "../../core/config/loader.js";
import { parseDuration } from "../../core/config/units.js";
import { ConfigError } from "../../core/errors.js";

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

export const CommandSchema = z.union([z.string().min(1), z.array(z.string()).min(1)]);
const Env = z.record(z.string(), z.string());

export const ReadyWhenSchema = z
  .object({
    path: z.string().startsWith("/").default("/"),
    status: z.array(z.number().int().min(100).max(599)).min(1).optional(),
    bodyContains: z.string().optional(),
    timeout: Duration.default(30_000),
    interval: Duration.default(200),
  })
  .strict();

/** Fields shared by the baseline and variants. Variants inherit every field they do not set. */
const ArmFields = {
  description: z.string().optional(),
  /** Already-running target ("external target" arm). Mutually exclusive with `start`. */
  target: z.url({ protocol: /^https?$/ }).optional(),
  /** Command that runs the app in the foreground (it receives a free port in `portEnv`). */
  start: CommandSchema.optional(),
  /** One-time command before the arm's first run (e.g. `docker compose up -d`). */
  setup: CommandSchema.optional(),
  /** One-time command after the arm's last run. */
  teardown: CommandSchema.optional(),
  /** Per-run reset hook for this arm (overrides `design.reset`). */
  reset: CommandSchema.optional(),
  cwd: z.string().optional(),
  env: Env.optional(),
  portEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
  readyWhen: ReadyWhenSchema.optional(),
  /** Partial Performance Lab input merged over the experiment workload (e.g. another endpoint path). */
  workload: z.record(z.string(), z.unknown()).optional(),
};

export const BaselineArmSchema = z
  .object({ name: z.string().min(1).default("baseline"), ...ArmFields })
  .strict();
export const VariantArmSchema = z.object({ name: z.string().min(1), ...ArmFields }).strict();

/** `">= 15%"`, `"15%"`, `0.15` → 0.15. */
export function parseImprovement(v: string | number): number {
  if (typeof v === "number") return v > 1 ? v / 100 : v;
  const m = /^\s*(?:>=?|≥)?\s*([0-9]*\.?[0-9]+)\s*(%?)\s*$/.exec(v);
  if (!m) throw new Error(`invalid improvement "${v}" (expected e.g. ">= 15%")`);
  const n = Number(m[1]);
  return m[2] === "%" || n > 1 ? n / 100 : n;
}

export const SuccessCriterionSchema = z
  .object({
    /** Required improvement in the metric's good direction, e.g. ">= 15%". */
    improvement: z
      .union([z.string(), z.number()])
      .transform((v, ctx) => {
        try {
          return parseImprovement(v);
        } catch (e) {
          ctx.addIssue({ code: "custom", message: (e as Error).message });
          return z.NEVER;
        }
      })
      .optional(),
    /** The metric must not regress (verdict ≠ regressed). */
    notWorse: z.boolean().optional(),
  })
  .strict();

export const DesignSchema = z
  .object({
    repetitions: z.number().int().min(1).max(1000).default(5),
    order: z.enum(["interleaved", "randomized-blocks", "sequential"]).default("interleaved"),
    seed: z.number().int().default(1),
    /** Reset hook run before every run (all arms). */
    reset: CommandSchema.optional(),
    /** "per-run": fresh app process for every run (independent repetitions, default). "per-arm": one process per arm for all its runs. */
    lifecycle: z.enum(["per-run", "per-arm"]).default("per-run"),
    /** Pause between runs. */
    cooldown: Duration.default(0),
  })
  .strict();

export const ProjectionSchema = z
  .object({
    /** Arrival rates (req/s) to project latency at, with an M/M/1 queueing estimate. */
    rates: z.array(z.number().positive()).default([]),
    /** Concurrency levels to project throughput at, from a USL fit of `points`. */
    concurrency: z.array(z.number().positive()).default([]),
    /** Measured (N, X) points for a USL fit (e.g. from a stress run's curves). */
    points: z.array(z.object({ n: z.number().positive(), x: z.number().nonnegative() }).strict()).default([]),
  })
  .strict();

export const ExperimentSchema = z
  .object({
    name: z.string().min(1),
    hypothesis: z.string().optional(),
    /** "compare": baseline vs variants. "aa": baseline vs an identical copy (noise floor / minimum detectable effect). */
    mode: z.enum(["compare", "aa"]).default("compare"),
    baseline: BaselineArmSchema.default({ name: "baseline" }),
    variants: z.array(VariantArmSchema).default([]),
    /** Performance Lab input without (or with a default) `target`. */
    workload: z.record(z.string(), z.unknown()).default({}),
    metrics: z.array(z.string().min(1)).min(1).default(["p95", "p99", "rps", "error_rate"]),
    success: z.record(z.string(), SuccessCriterionSchema).default({}),
    design: DesignSchema.default({
      repetitions: 5,
      order: "interleaved",
      seed: 1,
      lifecycle: "per-run",
      cooldown: 0,
    }),
    alpha: z.number().gt(0).lt(1).default(0.05),
    /** Bootstrap resamples. */
    bootstrap: z.number().int().min(100).max(100_000).default(10_000),
    /** |relative change| inside which a precise result is "no-significant-change". */
    equivalenceMargin: z.number().gt(0).lt(1).default(0.05),
    projection: ProjectionSchema.optional(),
    /** Working directory for commands (default process.cwd()). */
    cwd: z.string().optional(),
    /** Timeout for setup/reset/teardown commands. */
    commandTimeout: Duration.default(120_000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === "compare" && v.variants.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["variants"],
        message: 'mode "compare" needs at least one variant (or use mode "aa")',
      });
    }
    const names = new Set([v.baseline.name]);
    for (const [i, a] of v.variants.entries()) {
      if (names.has(a.name))
        ctx.addIssue({
          code: "custom",
          path: ["variants", i, "name"],
          message: `duplicate arm name "${a.name}"`,
        });
      names.add(a.name);
    }
    for (const [i, a] of [v.baseline, ...v.variants].entries()) {
      if (a.target && a.start) {
        ctx.addIssue({
          code: "custom",
          path: i === 0 ? ["baseline"] : ["variants", i - 1],
          message: "use either `target` or `start`, not both",
        });
      }
    }
    for (const m of Object.keys(v.success)) {
      if (!v.metrics.includes(m))
        ctx.addIssue({
          code: "custom",
          path: ["success", m],
          message: `success metric "${m}" is not in metrics`,
        });
    }
  });

export type ExperimentInput = z.output<typeof ExperimentSchema>;
export type ExperimentInputLoose = z.input<typeof ExperimentSchema>;
export type ArmInput = z.output<typeof BaselineArmSchema>;
export type ReadyWhenInput = z.output<typeof ReadyWhenSchema>;
export type SuccessCriterion = z.output<typeof SuccessCriterionSchema>;

/** `experiment({...})` helper for typed config files (spec §A.2). */
export function experiment(def: ExperimentInputLoose): ExperimentInputLoose {
  return def;
}

function issuesOf(e: z.ZodError): string[] {
  // Unknown keys get one line each with a typo suggestion (shared with the config loader).
  return zodIssueLines(e, { schema: ExperimentSchema }).map((i) => `${i.path || "(root)"}: ${i.message}`);
}

export function parseExperimentInput(input: unknown): ExperimentInput {
  const r = ExperimentSchema.safeParse(input);
  if (!r.success) {
    const issues = issuesOf(r.error);
    throw new ConfigError("SW_CONFIG_WHATIF", `Invalid experiment: ${issues.join("; ")}`, {
      hint: "See docs/03-engines/experiments.md §A.2",
      details: { issues },
    });
  }
  return r.data;
}

// ---------------------------------------------------------------------------------------------
// Evolution (Part B)

export const CandidateRefSchema = z
  .string()
  .regex(
    /^(branch|commit|patch):.+$/,
    'candidate must be "branch:<name>", "commit:<sha>" or "patch:<file.diff>"',
  );

export const EvolutionSchema = z
  .object({
    /** Repository directory (default process.cwd()). */
    repo: z.string().optional(),
    /** Baseline commit-ish (default HEAD). The user's working tree is never used directly. */
    baseline: z.string().min(1).default("HEAD"),
    candidates: z.array(CandidateRefSchema).min(1),
    /** Finding id/fingerprint the candidates address (report only). */
    finding: z.string().optional(),
    install: z
      .object({
        /** Install command; default by lockfile (npm ci / pnpm install --frozen-lockfile / yarn install --immutable); none without a lockfile. */
        command: CommandSchema.optional(),
        /**
         * "link": reuse node_modules from the repo (or an earlier arm with the same lockfile hash) via a
         * junction/symlink — no copy; "copy": recursive copy; "install": always run the install command;
         * "none": skip.
         */
        strategy: z.enum(["link", "copy", "install", "none"]).default("link"),
        timeout: Duration.default(600_000),
      })
      .strict()
      .default({ strategy: "link", timeout: 600_000 }),
    build: CommandSchema.optional(),
    test: CommandSchema.optional(),
    /** Extra correctness gates (commands). */
    invariants: z.array(z.object({ name: z.string(), command: CommandSchema }).strict()).default([]),
    /** Regression replays from Bug Hunter history (artifact paths), run against each started candidate. */
    replays: z
      .object({
        artifacts: z.array(z.string()).default([]),
        runs: z.number().int().min(1).max(20).default(3),
        /** Bug Hunter input (openapi, auth …); `target` is set to the candidate URL. */
        bugs: z.record(z.string(), z.unknown()).default({}),
      })
      .strict()
      .optional(),
    gateTimeout: Duration.default(600_000),
    start: CommandSchema,
    env: Env.default({}),
    portEnv: z.string().default("PORT"),
    health: z.string().startsWith("/").default("/"),
    readyWhen: ReadyWhenSchema.optional(),
    workload: z.record(z.string(), z.unknown()).default({}),
    metrics: z.array(z.string().min(1)).min(1).default(["p95", "p99", "rps", "error_rate"]),
    /** Metrics used for Pareto ranking (default: success keys, else metrics). */
    rankBy: z.array(z.string()).optional(),
    success: z.record(z.string(), SuccessCriterionSchema).default({}),
    /** Tie-break weights per metric (score = Σ w·oriented relative improvement). */
    weights: z.record(z.string(), z.number()).default({}),
    design: DesignSchema.default({
      repetitions: 5,
      order: "interleaved",
      seed: 1,
      lifecycle: "per-run",
      cooldown: 0,
    }),
    alpha: z.number().gt(0).lt(1).default(0.05),
    bootstrap: z.number().int().min(100).max(100_000).default(10_000),
    sandbox: z
      .object({
        /** "auto": docker when reachable, otherwise refuse (process needs explicit opt-in). */
        kind: z.enum(["auto", "docker", "process"]).default("auto"),
        image: z.string().optional(),
        cpus: z.number().positive().default(1),
        memory: z.string().default("1g"),
        /** Network for build/test/invariants containers ("none" = no egress). Install always uses the default network. */
        network: z.string().default("none"),
        user: z.string().default("1000:1000"),
      })
      .strict()
      .default({ kind: "auto", cpus: 1, memory: "1g", network: "none", user: "1000:1000" }),
    /** Temp root for worktrees (default os.tmpdir()). Keep short on Windows. */
    tmpDir: z.string().optional(),
    keepWorktrees: z.boolean().default(false),
    /**
     * Paths (absolute, or relative to `repo`) of SECOND WORLD's own state left out of the working-tree
     * checksum: history dir, report outDir, caches, audit log. Every `.second-world/` dir is always excluded.
     */
    ignorePaths: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type EvolutionInput = z.output<typeof EvolutionSchema>;
export type EvolutionInputLoose = z.input<typeof EvolutionSchema>;

export function parseEvolutionInput(input: unknown): EvolutionInput {
  const r = EvolutionSchema.safeParse(input);
  if (!r.success) {
    const issues = issuesOf(r.error);
    throw new ConfigError("SW_CONFIG_EVOLUTION", `Invalid evolution input: ${issues.join("; ")}`, {
      hint: "See docs/03-engines/experiments.md §B.6",
      details: { issues },
    });
  }
  return r.data;
}
