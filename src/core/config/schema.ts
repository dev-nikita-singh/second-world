/**
 * Config schema (single source of truth). See docs/08-configuration.md §1–3 and ADR-007.
 * Human units (durations, rates, percentages) are normalised here: ms, per-second, 0..1.
 * Engine sections owned by other agents (performance, stress, ...) are passed through as
 * records and validated by the engine's own input schema at run time.
 */
import { z } from "zod";
import { parseBytes, parseDuration, parsePercent, parseRate } from "./units.js";

function unit(parse: (v: string | number) => number, kind: string) {
  return z.union([z.string(), z.number()]).transform((v, ctx) => {
    try {
      return parse(v);
    } catch {
      ctx.addIssue({ code: "custom", message: `Invalid ${kind} ${JSON.stringify(v)}` });
      return z.NEVER;
    }
  });
}

export const zDuration = () => unit(parseDuration, 'duration (e.g. "250ms", "30s", "1h30m")');
export const zRate = () => unit(parseRate, 'rate (e.g. 200, "200/s", "12000/m")');
export const zPercent = () => unit(parsePercent, 'percentage (e.g. "1%", 0.01)');
export const zBytes = () => unit(parseBytes, 'size (e.g. "10KB", "5MiB")');

/** `{ env: "NAME" }` or `{ file: "./secret.txt" }` — resolved at runtime, never persisted. */
export const SecretRefSchema = z.union([
  z.object({ env: z.string().min(1) }).strict(),
  z.object({ file: z.string().min(1) }).strict(),
]);
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const EnvironmentSchema = z.enum(["local", "isolated", "staging", "production"]);

export const TargetSchema = z
  .object({
    url: z.url({ protocol: /^(https?|wss?)$/ }),
    health: z.string().optional(),
    role: z.enum(["service", "dependency"]).default("service"),
    tls: z.object({ insecure: z.boolean().default(false), ca: z.string().optional() }).optional(),
  })
  .strict();

export const SafetySchema = z
  .object({
    allowHosts: z.array(z.string().min(1)).default(["127.0.0.1", "localhost", "::1"]),
    allowPublic: z.boolean().default(false),
    maxRps: zRate().pipe(z.number().positive()).default(2000),
    maxConcurrency: z.number().int().positive().default(500),
    maxRequests: z.number().int().positive().default(2_000_000),
    /** ms after normalisation */
    maxDuration: zDuration()
      .pipe(z.number().positive())
      .default(30 * 60_000),
    allowMutations: z.boolean().default(false),
    approveDisruptive: z.boolean().default(false),
    redact: z
      .object({
        headers: z
          .array(z.string())
          .default(["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"]),
        bodyPaths: z.array(z.string()).default([]),
      })
      .strict()
      .default({
        headers: ["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"],
        bodyPaths: [],
      }),
  })
  .strict();

export const ReportFormatSchema = z.enum(["tty", "json", "md", "junit", "sarif", "html"]);
export const FailOnSchema = z.enum(["critical", "high", "medium", "low", "never"]);

export const ReportSchema = z
  .object({
    formats: z.array(ReportFormatSchema).default(["tty", "json"]),
    outDir: z.string().default(".second-world/reports"),
    failOn: FailOnSchema.default("high"),
  })
  .strict();

export const HistorySchema = z
  .object({
    /** Auto-save CLI runs (perf/stress/inspect) to history. */
    enabled: z.boolean().default(true),
    backend: z.enum(["jsonl", "sqlite"]).default("jsonl"),
    dir: z.string().default(".second-world/history"),
    baseline: z.string().optional(),
    retain: z
      .object({ runs: z.number().int().positive().default(200) })
      .strict()
      .default({ runs: 200 }),
  })
  .strict();

export const WorkflowStepSchema = z
  .object({
    engine: z.string().min(1),
    after: z.array(z.string()).default([]),
    optional: z.boolean().default(false),
    continueOnError: z.boolean().default(false),
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const WorkflowSchema = z
  .object({
    steps: z.record(z.string(), WorkflowStepSchema),
    concurrency: z.number().int().positive().optional(),
  })
  .strict();

const Section = z.record(z.string(), z.unknown());

export const ConfigSchema = z
  .object({
    $schemaVersion: z.literal(1).optional(),
    $schema: z.string().optional(),
    project: z
      .object({ root: z.string().default("."), name: z.string().optional() })
      .strict()
      .default({ root: "." }),
    environment: EnvironmentSchema.default("local"),
    targets: z.record(z.string(), TargetSchema).default({}),
    safety: SafetySchema.default(() => SafetySchema.parse({})),
    auth: Section.optional(),
    hooks: Section.optional(),
    performance: Section.optional(),
    stress: Section.optional(),
    architecture: Section.optional(),
    bugs: Section.optional(),
    agent: Section.optional(),
    reliability: Section.optional(),
    model: Section.optional(),
    /** What-If experiments by name (docs/03-engines/experiments.md §A.2); validated by the engine at run time. */
    whatif: z
      .object({ experiments: z.record(z.string(), z.record(z.string(), z.unknown())).default({}) })
      .strict()
      .optional(),
    evolution: Section.optional(),
    report: ReportSchema.default(() => ReportSchema.parse({})),
    history: HistorySchema.default(() => HistorySchema.parse({})),
    workflows: z.record(z.string(), WorkflowSchema).default({}),
    profiles: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    plugins: z.array(z.string()).default([]),
    ui: z.object({ color: z.boolean().optional(), unicode: z.boolean().optional() }).strict().optional(),
  })
  .strict();

/** What users write (units as strings, everything optional). */
export type ConfigInput = z.input<typeof ConfigSchema>;
/** Validated, normalised config. */
export type Config = z.output<typeof ConfigSchema>;

export const CONFIG_SECTIONS: readonly string[] = Object.keys(ConfigSchema.shape);

/** Identity helper for typed config files (`sw.config.ts`). */
export function defineConfig<T extends ConfigInput>(config: T): T {
  return config;
}

/** JSON Schema for editors (`sw config schema`). */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ConfigSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}
