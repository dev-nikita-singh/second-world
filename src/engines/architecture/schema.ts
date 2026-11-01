/**
 * Architecture Inspector input schema — docs/03-engines/architecture-inspector.md §1, §4, §7.
 * Rule config is ESLint-like: `off | warn | error` or `[level, options]`.
 */
import { z } from "zod";

export const RuleLevelSchema = z.enum(["off", "warn", "error"]);
export type RuleLevel = z.infer<typeof RuleLevelSchema>;

export const RuleConfigEntrySchema = z.union([
  RuleLevelSchema,
  z.tuple([RuleLevelSchema]),
  z.tuple([RuleLevelSchema, z.record(z.string(), z.unknown())]),
]);
export type RuleConfigEntry = z.infer<typeof RuleConfigEntrySchema>;

export const FRAMEWORK_IDS = ["express", "fastify", "nest", "hono", "koa", "next", "node-http"] as const;
export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

export const ArchitectureInputSchema = z.object({
  /** Project root (absolute or relative to cwd). */
  project: z.string().min(1).default("."),
  /** tsconfig path relative to the project root; default: `tsconfig.json` when present. */
  tsconfig: z.string().optional(),
  /** Glob patterns (relative to root). Default: all TS/JS sources. */
  include: z.array(z.string()).optional(),
  /** Extra ignore globs (on top of .gitignore, .swignore and built-in ignores). */
  exclude: z.array(z.string()).default([]),
  maxFiles: z.number().int().positive().default(20_000),
  maxFileSizeBytes: z.number().int().positive().default(1_000_000),
  frameworks: z.union([z.literal("auto"), z.array(z.enum(FRAMEWORK_IDS))]).default("auto"),
  rules: z.record(z.string(), RuleConfigEntrySchema).default({}),
  /** Cache directory (relative to root). Default `.second-world/cache/arch`. */
  cacheDir: z.string().optional(),
  noCache: z.boolean().default(false),
  /** Respect .gitignore files (default true). */
  gitignore: z.boolean().default(true),
});

export type ArchitectureInput = z.infer<typeof ArchitectureInputSchema>;
export type ArchitectureInputLoose = z.input<typeof ArchitectureInputSchema>;
