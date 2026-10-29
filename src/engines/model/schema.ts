/**
 * System Model input schema — docs/03-engines/system-model.md (all sources optional; the model is built
 * from whatever evidence is given and says what it was built from).
 */
import { z } from "zod";

export const PrometheusSourceSchema = z.union([
  z.string(),
  z.object({
    file: z.string().optional(),
    text: z.string().optional(),
    url: z.string().optional(),
    service: z.string().optional(),
    atMs: z.number().optional(),
  }),
]);

export const ModelInputSchema = z
  .object({
    /** Project root (static analysis, config discovery, code env scan). */
    project: z.string().optional(),
    /** Name of the project's own service (default: package.json name, else the project folder name). */
    serviceName: z.string().optional(),
    detail: z.enum(["components", "full"]).default("components"),
    /** Run the Architecture Inspector (default: true when `project` is set). Object = extra inspector input. */
    architecture: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
    /** Precomputed ArchitectureData (skips running the inspector). */
    architectureData: z.unknown().optional(),
    /** Inspector cache dir (default <project>/.second-world/cache/arch). */
    cacheDir: z.string().optional(),
    openapi: z.union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())]).optional(),
    config: z
      .object({
        files: z.array(z.string()).default([]),
        /** Discover docker-compose / k8s / .env / package.json in the project root. */
        discover: z.boolean().default(true),
      })
      .default({ files: [], discover: true }),
    /** OTLP/JSON (or JSONL) files with traces and/or metrics. */
    traces: z.array(z.string()).default([]),
    /** In-memory telemetry (e.g. from startOtlpReceiver): normalized spans/metrics or raw OTLP payloads. */
    telemetry: z
      .object({
        spans: z.array(z.unknown()).optional(),
        metrics: z.array(z.unknown()).optional(),
        payloads: z.array(z.unknown()).optional(),
      })
      .optional(),
    prometheus: z.array(PrometheusSourceSchema).default([]),
    /** Performance Lab results (EngineResult<PerformanceData> or PerformanceData). */
    performance: z.array(z.unknown()).default([]),
    /** Reliability Lab results (controlled experiments). */
    reliability: z.array(z.unknown()).default([]),
    /** Findings (or EngineResults) to attach as failure modes. */
    findings: z.array(z.unknown()).default([]),
    resolution: z
      .object({
        threshold: z.number().min(0.5).max(1).default(0.92),
        fuzzy: z.boolean().default(true),
      })
      .default({ threshold: 0.92, fuzzy: true }),
    maxSpans: z.number().int().positive().default(1_000_000),
    maxCriticalPaths: z.number().int().min(0).default(50),
  })
  .strict();

export type ModelInput = z.output<typeof ModelInputSchema>;
export type ModelInputLoose = z.input<typeof ModelInputSchema>;
