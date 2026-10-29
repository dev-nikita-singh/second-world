/**
 * Shared evidence model. Every engine emits findings in this shape.
 * See docs/03-engines/evidence-and-history.md §A.1 and docs/01-vision-and-principles.md §5.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const EngineIdSchema = z.enum([
  "performance",
  "stress",
  "architecture",
  "bugs",
  "agent",
  "reliability",
  "model",
  "whatif",
  "evolution",
  "reporting",
  "history",
]);
export type EngineId = z.infer<typeof EngineIdSchema>;

/** Trust ladder L0..L5, weakest first. */
export const ClassificationSchema = z.enum([
  "hypothesis",
  "suspected-risk",
  "observation",
  "threshold-breach",
  "reproduced-defect",
  "verified-fix",
]);
export type Classification = z.infer<typeof ClassificationSchema>;

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const CategorySchema = z.enum([
  "performance",
  "capacity",
  "architecture",
  "bug",
  "reliability",
  "security",
  "correctness",
]);
export type Category = z.infer<typeof CategorySchema>;

export const TimeRangeSchema = z.object({ start: z.string(), end: z.string() });
export type TimeRange = z.infer<typeof TimeRangeSchema>;

export const SourceLocationSchema = z.object({
  file: z.string(), // POSIX-style path relative to project root
  line: z.number().int().min(1),
  column: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  symbol: z.string().optional(),
  snippetHash: z.string().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

export const EvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("measurement"),
    metric: z.string(),
    value: z.number(),
    unit: z.string(),
    window: TimeRangeSchema.optional(),
    runId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("threshold"),
    expression: z.string(),
    actual: z.number(),
    passed: z.boolean(),
  }),
  z.object({ kind: z.literal("code"), location: SourceLocationSchema, ruleId: z.string() }),
  z.object({
    kind: z.literal("http-exchange"),
    artifact: z.string().optional(),
    requestHash: z.string(),
    method: z.string(),
    url: z.string(),
    status: z.number().optional(),
  }),
  z.object({ kind: z.literal("trace"), traceId: z.string(), spanIds: z.array(z.string()) }),
  z.object({
    kind: z.literal("comparison"),
    metric: z.string(),
    change: z.number(),
    ci95: z.tuple([z.number(), z.number()]),
    pValue: z.number().optional(),
  }),
  z.object({ kind: z.literal("note"), text: z.string() }),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ReproductionSchema = z.object({
  steps: z.array(z.string()),
  command: z.string().optional(),
  seed: z.number().optional(),
  artifacts: z.array(z.string()).default([]),
});
export type Reproduction = z.infer<typeof ReproductionSchema>;

export const FindingSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: z.string(),
  fingerprint: z.string(),
  engine: EngineIdSchema,
  ruleId: z.string().optional(),
  category: CategorySchema,
  title: z.string().max(200),
  description: z.string().default(""),
  severity: SeveritySchema,
  classification: ClassificationSchema,
  status: z.enum(["open", "acknowledged", "fixed", "wont-fix", "false-positive"]).default("open"),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema).min(1),
  locations: z.array(SourceLocationSchema).default([]),
  affected: z.array(z.string()).default([]),
  reproduction: ReproductionSchema.optional(),
  impact: z.string().optional(),
  recommendation: z.string().optional(),
  related: z
    .array(
      z.object({
        id: z.string(),
        relation: z.enum(["causes", "caused-by", "duplicates", "verifies", "related"]),
      }),
    )
    .default([]),
  occurrences: z.number().int().min(1).default(1),
  firstSeen: z.string(),
  lastSeen: z.string(),
  tags: z.array(z.string()).default([]),
});
export type Finding = z.infer<typeof FindingSchema>;
export type FindingInput = z.input<typeof FindingSchema>;

export const LimitationSchema = z.object({
  code: z.string(),
  message: z.string(),
  impact: z.enum(["invalidates", "reduces-confidence", "informational"]).default("informational"),
});
export type Limitation = z.infer<typeof LimitationSchema>;

export const ArtifactRefSchema = z.object({
  name: z.string(),
  path: z.string(),
  mediaType: z.string(),
  sha256: z.string().optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const EngineStatusSchema = z.enum(["passed", "failed", "partial", "skipped", "error", "cancelled"]);
export type EngineStatus = z.infer<typeof EngineStatusSchema>;

export const EngineResultSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  engine: EngineIdSchema,
  runId: z.string(),
  status: EngineStatusSchema,
  startedAt: z.string(),
  endedAt: z.string(),
  findings: z.array(FindingSchema).default([]),
  limitations: z.array(LimitationSchema).default([]),
  artifacts: z.array(ArtifactRefSchema).default([]),
  /** Engine-specific payload (e.g. PerformanceData). */
  data: z.unknown().optional(),
});
export type EngineResult<D = unknown> = Omit<z.infer<typeof EngineResultSchema>, "data"> & { data?: D };
