/**
 * Reliability Lab input. See docs/03-engines/reliability-lab.md §2 (experiment structure, blast radius),
 * §5 (usage) and §6 (default safety).
 */
import { z } from "zod";
import { FaultSchema } from "../../adapters/faults/types.js";
import { parseDuration } from "../../core/config/units.js";
import { IdempotencySchema, InvariantSchema } from "./invariants.js";

const Ms = z.union([z.string(), z.number()]).transform((v, ctx) => {
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

const Percent = z.union([z.number(), z.string()]).transform((v, ctx) => {
  // accepts 0.05, "5%", 5 (→ 5%) ; numbers > 1 are percentages
  const n =
    typeof v === "string"
      ? v.trim().endsWith("%")
        ? Number(v.trim().slice(0, -1)) / 100
        : Number(v)
      : v > 1
        ? v / 100
        : v;
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    ctx.addIssue({ code: "custom", message: `invalid percentage ${String(v)}` });
    return z.NEVER;
  }
  return n;
});

export const RouteSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.-]+$/, "route names: letters, digits, _ . -"),
    method: z.string().default("GET"),
    path: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
    /** Raw body (may contain perf `{{templates}}`). */
    body: z.string().optional(),
    json: z.unknown().optional(),
    weight: z.number().positive().default(1),
    /** Dependencies this route calls (isolation analysis). Omit = unknown. */
    dependsOn: z.array(z.string()).optional(),
    /**
     * Auth role name from config.auth (F10). The World resolves it into headers before the run;
     * a role still present here was not resolvable → sent without credentials + limitation.
     */
    auth: z.string().min(1).optional(),
    /**
     * One unique key per logical operation (Idempotency-Key header and/or `$SW_OP_KEY` in
     * path/body/headers), reused on client retries; outcomes feed the `invariants` checks.
     */
    idempotency: IdempotencySchema.optional(),
  })
  .strict();

export const DependencySchema = z
  .object({
    /** Injector used for this dependency. Default "builtin". */
    injector: z.enum(["builtin", "toxiproxy", "docker"]).default("builtin"),
    /** builtin: real upstream ("http://127.0.0.1:4010"); the app must call the proxy instead. */
    upstream: z.string().optional(),
    /** builtin: proxy listen port (the app's configured dependency port). 0 = random. */
    listen: z.number().int().min(0).max(65535).optional(),
    mode: z.enum(["http", "tcp"]).default("http"),
    /** toxiproxy: API URL + proxy name. */
    toxiproxy: z.object({ apiUrl: z.string().optional(), proxy: z.string() }).strict().optional(),
    /** docker: container (and network for network-disconnect). */
    container: z.string().optional(),
    network: z.string().optional(),
  })
  .strict();

export const ReliabilityInputSchema = z
  .object({
    /** The application under test (workload target). */
    target: z.url({ protocol: /^https?$/ }),
    /** Catalogue scenario id (see listScenarios()). */
    scenario: z.string().min(1),
    /** Dependency to degrade (key of `dependencies`). */
    dependency: z.string().min(1),
    dependencies: z.record(z.string(), DependencySchema).default({}),
    /** Scenario parameters, e.g. { latency: "2s", status: 503, percent: 30, onMs: 1000, offMs: 1000 }. */
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    /** Custom fault (overrides the scenario's). */
    fault: FaultSchema.optional(),
    environment: z.enum(["local", "isolated", "staging", "production"]).optional(),
    allowProduction: z.boolean().default(false),
    workload: z
      .object({
        routes: z.array(RouteSchema).default([]),
        /** Open-model arrival rate (requests/s), Poisson arrivals. */
        rate: z.number().positive().max(10_000).default(10),
        arrival: z.enum(["poisson", "constant"]).default("poisson"),
        timeout: Ms.default(15_000),
      })
      .strict()
      .default({ routes: [], rate: 10, arrival: "poisson", timeout: 15_000 }),
    /** Phase durations. */
    steady: Ms.default(3_000),
    duration: Ms.default(10_000),
    recovery: Ms.default(5_000),
    /** Ramp the fault magnitude in N steps (latency, percent). */
    ramp: z
      .object({ steps: z.number().int().min(1).max(20) })
      .strict()
      .optional(),
    /** Steady-state thresholds (must hold before injection), e.g. ["p95<300ms", "error_rate<1%"]. */
    steadyState: z.array(z.string()).default([]),
    /** Hypothesis thresholds evaluated during the fault, e.g. ["error_rate<5%", "scenario.browse.p95<200ms"]. */
    hypothesis: z.array(z.string()).default([]),
    /** Abort condition: error rate over the last second above this → immediate revert. */
    abort: z
      .object({ errorRate: Percent, graceMs: Ms.default(1000) })
      .strict()
      .optional(),
    /** Hard cap on the whole experiment (all repetitions). */
    maxDuration: Ms.default(600_000),
    /** Repetitions; a detector hit in every one of ≥ 2 repetitions is a reproduced defect. */
    repeat: z.number().int().min(1).max(10).default(1),
    /** Configured client→dependency timeout to verify (ms, per client request). */
    expectTimeout: Ms.optional(),
    /**
     * Duplicate-operation invariants evaluated after the recovery phase of every repetition:
     * no-duplicates, count-matches, conserved (see invariants.ts).
     */
    invariants: z.array(InvariantSchema).max(20).default([]),
    seed: z.number().int().optional(),
  })
  .strict();

export type ReliabilityInput = z.output<typeof ReliabilityInputSchema>;
export type ReliabilityInputLoose = z.input<typeof ReliabilityInputSchema>;
export type RouteSpec = z.output<typeof RouteSchema>;
export type DependencySpec = z.output<typeof DependencySchema>;
export type { IdempotencySpec, InvariantSpec } from "./invariants.js";
