/**
 * Adversarial Test Agent input. docs/03-engines/adversarial-test-agent.md §1–§6.
 * Target/contract/auth/hooks/values are the Bug Hunter's (the agent executes through the same
 * session machinery); the rest configures the planner, the bandit and the budgets.
 */
import { z } from "zod";
import { parseDuration } from "../../core/config/units.js";
import { AuthSchema, HookSchema, ResourceSchema } from "../bugs/schema.js";

export const AGENT_TECHNIQUES = [
  "status-gap",
  "param-gap",
  "boundary",
  "idempotency",
  "idempotency-concurrent",
  "ownership",
  "privilege",
  "lifecycle",
  "concurrency",
  "history",
  "arch-risk",
] as const;
export type AgentTechnique = (typeof AGENT_TECHNIQUES)[number];

const Duration = z.union([z.number().nonnegative(), z.string()]).transform((v, ctx) => {
  try {
    return parseDuration(v);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

export const AgentInputSchema = z
  .object({
    target: z.url({ protocol: /^https?$/ }),
    /** OpenAPI contract (path or inline). Required: steps may only reference contract operations. */
    openapi: z.union([z.string(), z.record(z.string(), z.unknown())]),
    cwd: z.string().optional(),
    seed: z.number().int().optional(),
    timeout: Duration.default(5_000),
    headers: z.record(z.string(), z.string()).default({}),
    auth: AuthSchema.default({ roles: {}, invalidToken: "sw-invalid-token-0000", privileged: [] }),
    hooks: z.object({ setup: HookSchema.optional(), reset: HookSchema.optional() }).strict().default({}),
    values: z.record(z.string(), z.array(z.unknown())).default({}),
    /**
     * Resources for the ownership / lifecycle techniques, same shape as the Bug Hunter's
     * `stateful.resources` (config: forwarded from `bugs.stateful.resources` unless `agent.resources`
     * is set). Absent → derived from the contract (POST /x + GET /x/{id}, id at "/id").
     */
    resources: z.array(ResourceSchema).optional(),
    allowMutations: z.boolean().optional(),
    /** Approval for destructive operations (DELETE, mutating admin/purge/reset paths, `destructive` patterns). */
    allowDestructive: z.boolean().default(false),
    destructive: z.array(z.string()).default([]),
    planner: z.literal("heuristic").default("heuristic"),
    bandit: z.enum(["ucb1", "thompson"]).default("ucb1"),
    exploration: z.number().nonnegative().default(1),
    techniques: z.array(z.enum(AGENT_TECHNIQUES)).default([...AGENT_TECHNIQUES]),
    operations: z
      .object({ include: z.array(z.string()).default([]), exclude: z.array(z.string()).default([]) })
      .strict()
      .default({ include: [], exclude: [] }),
    budget: z
      .object({
        maxIterations: z.number().int().positive().default(150),
        maxRequests: z.number().int().positive().default(2_000),
        maxDuration: Duration.optional(),
        /** k rounds without new information (finding or coverage bit) → stop. */
        patience: z.number().int().positive().default(40),
        maxRps: z.number().positive().optional(),
        maxConcurrency: z.number().int().positive().optional(),
      })
      .strict()
      .default({ maxIterations: 150, maxRequests: 2_000, patience: 40 }),
    replays: z.number().int().min(1).max(50).default(3),
    maxReplays: z.number().int().min(1).max(200).default(10),
    minimize: z.boolean().default(true),
    /** Concurrency limit for `parallel.copies`. */
    maxCopies: z.number().int().min(2).max(50).default(10),
    maxPayloadBytes: z
      .number()
      .int()
      .positive()
      .default(64 * 1024),
    /** Latency (ms) above which an architecture-risk probe counts as slow. */
    slowMs: z.number().positive().default(2_000),
    novelty: z.enum(["set", "bloom"]).default("set"),
    /** Previous results (bugs / architecture / history / agent EngineResults or report paths). */
    context: z
      .object({
        results: z.array(z.record(z.string(), z.unknown())).default([]),
        files: z.array(z.string()).default([]),
      })
      .strict()
      .default({ results: [], files: [] }),
    /** Pinned scenarios (e.g. exported suggested tests) run first, every run. Validated like any proposal. */
    regression: z.array(z.unknown()).default([]),
  })
  .strict();

export type AgentInput = z.output<typeof AgentInputSchema>;
export type AgentInputLoose = z.input<typeof AgentInputSchema>;
