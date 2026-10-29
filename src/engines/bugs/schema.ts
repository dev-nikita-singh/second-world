/**
 * API Bug Hunter input schema. docs/03-engines/api-bug-hunter.md §1–§6.
 */
import { z } from "zod";
import { parseDuration } from "../../core/config/units.js";

export const TECHNIQUES = [
  "contract",
  "boundary",
  "equivalence",
  "pairwise",
  "property",
  "negative",
  "stateful",
  "concurrency",
  "auth",
] as const;
export type Technique = (typeof TECHNIQUES)[number];

const Duration = z.union([z.number().nonnegative(), z.string()]).transform((v, ctx) => {
  try {
    return parseDuration(v);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

const Credential = z.union([
  z.object({ type: z.literal("bearer"), token: z.string(), privileged: z.boolean().optional() }).strict(),
  z
    .object({
      type: z.literal("basic"),
      username: z.string(),
      password: z.string(),
      privileged: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("header"),
      name: z.string(),
      value: z.string(),
      privileged: z.boolean().optional(),
    })
    .strict(),
]);
export type Credential = z.infer<typeof Credential>;

export const AuthSchema = z
  .object({
    /** Configured TEST accounts only (role name → credential). */
    roles: z.record(z.string(), Credential).default({}),
    /** Role used for ordinary requests to secured operations. Default: first non-privileged role. */
    default: z.string().optional(),
    /** BOLA: resource owner and the other (attacker) account. Defaults: first two non-privileged roles. */
    owner: z.string().optional(),
    attacker: z.string().optional(),
    /** Token sent as "invalid" (default a random-looking constant). */
    invalidToken: z.string().default("sw-invalid-token-0000"),
    /** Optional known-expired token for the auth matrix. */
    expiredToken: z.string().optional(),
    /** Operations that require a privileged role (in addition to the 403+admin heuristic). */
    privileged: z.array(z.string()).default([]),
  })
  .strict();

const HttpHook = z
  .object({
    method: z.string().default("POST"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.unknown().optional(),
    expectStatus: z.array(z.number().int()).optional(),
  })
  .strict();

export const HookSchema = z.union([
  z.object({ http: HttpHook }).strict(),
  z
    .object({
      command: z.union([z.string(), z.array(z.string()).min(1)]),
      cwd: z.string().optional(),
      timeout: Duration.default(30_000),
    })
    .strict(),
]);
export type Hook = z.infer<typeof HookSchema>;

const JsonCheck = z
  .object({
    pointer: z.string(),
    equals: z.unknown().optional(),
    exists: z.boolean().optional(),
    type: z.enum(["string", "number", "integer", "boolean", "array", "object", "null"]).optional(),
    matches: z.string().optional(),
  })
  .strict();

export const AssertionSchema = z
  .object({
    name: z.string().optional(),
    /** Operation pattern "GET /products/{id}" (`*` wildcards). */
    operation: z.string(),
    status: z.union([z.number().int(), z.array(z.number().int())]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    json: z.array(JsonCheck).default([]),
    maxDuration: Duration.optional(),
    /** Only check responses with these statuses (default: 2xx). */
    when: z.array(z.number().int()).optional(),
  })
  .strict();
export type Assertion = z.infer<typeof AssertionSchema>;

export const InvariantRefSchema = z.union([
  z.string(),
  z
    .object({
      module: z.string(),
      export: z.string().optional(),
      operations: z.array(z.string()).optional(),
      name: z.string().optional(),
    })
    .strict(),
]);

const BuiltinInvariant = z.union([
  z.object({ kind: z.literal("max-success"), max: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal("linearizable"),
      model: z.enum(["stock", "counter", "register", "set"]),
      initial: z.unknown().optional(),
      /** Units taken per successful request (stock model). Default 1. */
      take: z.number().int().positive().default(1),
    })
    .strict(),
  z.object({ kind: z.literal("same-response"), pointer: z.string().default("/id") }).strict(),
]);

/** Model operation a request performs in a mixed-operation history (docs/04 §7.5). */
export const MIX_OPS = ["take", "read", "inc", "dec", "write", "add", "remove", "has"] as const;
export type MixOp = (typeof MIX_OPS)[number];

export const MixEntrySchema = z
  .object({
    operation: z.string(),
    /** Copies of this request. */
    count: z.number().int().min(1).max(64).default(1),
    role: z.string().optional(),
    pathParams: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.unknown().optional(),
    /** What the request does on the sequential spec model. */
    as: z.enum(MIX_OPS),
    /** JSON pointer of the observed value in the response (read/has) or of the written value in the request body (write/add/remove). */
    pointer: z.string().optional(),
    /** Fixed element for set operations (default: from `pointer`). */
    value: z.string().optional(),
    /** before = sequentially before the burst, during = inside the barrier burst, after = sequentially once it returned. */
    phase: z.enum(["before", "during", "after"]).default("during"),
  })
  .strict();
export type MixEntry = z.infer<typeof MixEntrySchema>;

export const ConcurrencyTestSchema = z
  .object({
    name: z.string().optional(),
    operation: z.string(),
    burst: z.number().int().min(2).max(64).default(10),
    /** Model operation of the main request in a mixed history (default per model: take/inc/write/add). */
    as: z.enum(MIX_OPS).optional(),
    /** Pointer for the main request (see MixEntry.pointer). */
    pointer: z.string().optional(),
    /** Other operations interleaved with the burst, e.g. GET /products/{id} reads of the stock. */
    mix: z.array(MixEntrySchema).max(16).default([]),
    role: z.string().optional(),
    pathParams: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.unknown().optional(),
    /** Send the same generated Idempotency-Key with every request of the burst. */
    sameIdempotencyKey: z.boolean().default(false),
    invariant: z.union([BuiltinInvariant, InvariantRefSchema]).optional(),
    /** Optional post-state check after the burst. */
    postState: z
      .object({
        operation: z.string(),
        pathParams: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
        role: z.string().optional(),
        pointer: z.string(),
        op: z.enum([">=", "<=", "==", ">", "<"]),
        value: z.number(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((t) => t.burst + t.mix.filter((m) => m.phase === "during").reduce((n, m) => n + m.count, 0) <= 64, {
    message: "burst + concurrent mix requests must be ≤ 64 (linearizability histories are kept small)",
  });
export type ConcurrencyTest = z.infer<typeof ConcurrencyTestSchema>;

export const ResourceSchema = z
  .object({
    name: z.string(),
    create: z.string(),
    read: z.string(),
    update: z.string().optional(),
    delete: z.string().optional(),
    /** JSON pointer of the id in the create response. Default "/id". */
    idPointer: z.string().default("/id"),
    role: z.string().optional(),
    body: z.unknown().optional(),
  })
  .strict();
export type ResourceSpec = z.infer<typeof ResourceSchema>;

export const BugsInputSchema = z
  .object({
    target: z.url({ protocol: /^https?$/ }),
    /** OpenAPI 3.x / Swagger 2.0 file (or inline document). Absent → discovery mode. */
    openapi: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    /** Base directory for relative paths (contract, invariants, hooks). */
    cwd: z.string().optional(),
    techniques: z.array(z.enum(TECHNIQUES)).default([...TECHNIQUES]),
    operations: z
      .object({ include: z.array(z.string()).default([]), exclude: z.array(z.string()).default([]) })
      .strict()
      .default({ include: [], exclude: [] }),
    seed: z.number().int().optional(),
    propertyRuns: z.number().int().min(1).max(10_000).default(15),
    replays: z.number().int().min(1).max(100).default(3),
    maxReplays: z.number().int().min(1).max(1000).default(20),
    minimize: z.boolean().default(true),
    allowMutations: z.boolean().optional(),
    timeout: Duration.default(5_000),
    headers: z.record(z.string(), z.string()).default({}),
    auth: AuthSchema.default({ roles: {}, invalidToken: "sw-invalid-token-0000", privileged: [] }),
    hooks: z.object({ setup: HookSchema.optional(), reset: HookSchema.optional() }).strict().default({}),
    /** Known-good values by parameter/property name (e.g. productId: [1, 2]). */
    values: z.record(z.string(), z.array(z.unknown())).default({}),
    assertions: z.array(AssertionSchema).default([]),
    invariants: z.array(InvariantRefSchema).default([]),
    concurrency: z.array(ConcurrencyTestSchema).default([]),
    stateful: z
      .object({
        resources: z.array(ResourceSchema).optional(),
        runs: z.number().int().min(1).max(200).default(4),
        maxCommands: z.number().int().min(1).max(50).default(8),
      })
      .strict()
      .default({ runs: 4, maxCommands: 8 }),
    /** Max generated cases per operation and technique. */
    maxCasesPerOperation: z.number().int().min(1).default(40),
    budget: z
      .object({
        maxRequests: z.number().int().positive().default(5_000),
        maxRps: z.number().positive().optional(),
        maxConcurrency: z.number().int().positive().optional(),
        maxDuration: Duration.optional(),
      })
      .strict()
      .default({ maxRequests: 5_000 }),
    discover: z
      .object({ paths: z.array(z.string()).default(["GET /"]) })
      .strict()
      .optional(),
    /** Write one redacted reproduction JSON per finding here. */
    artifactsDir: z.string().optional(),
  })
  .strict();

export type BugsInput = z.output<typeof BugsInputSchema>;
export type BugsInputLoose = z.input<typeof BugsInputSchema>;
