/**
 * Scenario DSL of the Adversarial Test Agent — docs/03-engines/adversarial-test-agent.md §4.
 *
 * A scenario is pure data: steps reference contract operations by key ("POST /orders"),
 * roles by name (configured test accounts only), values are JSON. There is no URL, host,
 * shell, file-system or code field anywhere: unknown keys are rejected (`.strict()`), so an
 * AI proposal that adds `code`, `exec`, `url`… never parses (docs/11 §6: AI output is data).
 *
 * `{{var}}` placeholders reference values extracted by earlier steps; `{{$nonce}}` is replaced by
 * one fresh value per execution (e.g. an Idempotency-Key shared by two steps).
 */

import { z } from "zod";
import { zodIssueLines } from "../../core/config/loader.js";
import { sha256 } from "../../shared/util/hash.js";

/** Rule ids a scenario assertion may claim (bugs-compatible ids + agent-specific ones). */
export const AGENT_RULES = [
  "bugs/server-error",
  "bugs/server-error-on-boundary",
  "bugs/server-error-on-invalid-input",
  "bugs/schema-mismatch",
  "bugs/idempotency-key-ignored",
  "bugs/race-lost-update",
  "bugs/bola",
  "bugs/bfla",
  "bugs/missing-authentication",
  "bugs/state-model-mismatch",
  "bugs/undocumented-status",
  "agent/accepts-invalid-input",
  "agent/idempotency-key-race",
  "agent/slow-response",
  "agent/assertion-failed",
] as const;
export type AgentRule = (typeof AGENT_RULES)[number];

const Scalar = z.union([z.string().max(2048), z.number(), z.boolean()]);
const VarName = z.string().regex(/^[A-Za-z_][\w-]{0,63}$/);
const Pointer = z
  .string()
  .max(256)
  .regex(/^(\/[^/]*)*$/, "must be a JSON pointer ('' or '/a/b')");

export const StepSchema = z
  .object({
    /** Contract operation key, e.g. "GET /orders/{id}". Validated against the contract. */
    operation: z.string().min(3).max(300),
    /** Configured test-account role; null = anonymous; "$invalid" = invalid token. Omitted = default role. */
    role: z.string().max(64).nullable().optional(),
    pathParams: z.record(z.string().max(64), Scalar).optional(),
    query: z.record(z.string().max(64), z.union([Scalar, z.array(Scalar).max(20)])).optional(),
    headers: z.record(z.string().max(64), z.string().max(1024)).optional(),
    body: z.json().optional(),
    /** var name → JSON pointer into this step's response body. */
    extract: z.record(VarName, Pointer).optional(),
    label: z.string().max(200).optional(),
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;

const Rule = z.enum(AGENT_RULES).optional();
const StepIdx = z.number().int().min(0).max(49);

export const AssertionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("status"),
      step: StepIdx,
      oneOf: z.array(z.number().int().min(100).max(599)).min(1).max(20),
      rule: Rule,
    })
    .strict(),
  z
    .object({
      kind: z.literal("status-class"),
      step: StepIdx,
      class: z.enum(["2xx", "4xx", "not-2xx", "not-5xx"]),
      rule: Rule,
    })
    .strict(),
  z.object({ kind: z.literal("no-5xx"), rule: Rule }).strict(),
  z
    .object({
      kind: z.literal("same-json"),
      steps: z.tuple([StepIdx, StepIdx]),
      pointer: Pointer,
      rule: Rule,
    })
    .strict(),
  z.object({ kind: z.literal("copies-agree"), step: StepIdx, pointer: Pointer, rule: Rule }).strict(),
  z
    .object({
      kind: z.literal("max-success"),
      step: StepIdx,
      max: z.number().int().min(0).max(50),
      rule: Rule,
    })
    .strict(),
  z
    .object({
      kind: z.literal("json"),
      step: StepIdx,
      pointer: Pointer,
      equals: z.json().optional(),
      exists: z.boolean().optional(),
      type: z.enum(["string", "number", "integer", "boolean", "array", "object", "null"]).optional(),
      /** With `equals`: a response without the field passes (another representation, not a wrong value). */
      ifPresent: z.boolean().optional(),
      rule: Rule,
    })
    .strict(),
  z
    .object({
      kind: z.literal("max-duration"),
      step: StepIdx,
      ms: z.number().positive().max(600_000),
      rule: Rule,
    })
    .strict(),
  z.object({ kind: z.literal("schema-valid"), step: StepIdx, rule: Rule }).strict(),
]);
export type ScenarioAssertion = z.infer<typeof AssertionSchema>;

export const ScenarioSchema = z
  .object({
    title: z.string().min(1).max(200),
    hypothesis: z.string().min(1).max(1000),
    setup: z.array(StepSchema).max(10).default([]),
    steps: z.array(StepSchema).min(1).max(50),
    /** Send `copies` identical requests of step `step` (default: last step) concurrently. */
    parallel: z
      .object({ copies: z.number().int().min(2).max(50), step: StepIdx.optional() })
      .strict()
      .optional(),
    assertions: z.array(AssertionSchema).min(1).max(20),
    expectedClassification: z.enum(["defect", "contract-gap"]),
  })
  .strict()
  .superRefine((s, ctx) => {
    const n = s.steps.length;
    const bad = (path: (string | number)[], msg: string): void => {
      ctx.addIssue({ code: "custom", path, message: msg });
    };
    if (s.parallel?.step !== undefined && s.parallel.step >= n)
      bad(["parallel", "step"], "step out of range");
    s.assertions.forEach((a, i) => {
      const idx = a.kind === "same-json" ? a.steps : a.kind === "no-5xx" ? [] : [a.step];
      for (const x of idx) if (x >= n) bad(["assertions", i], `step ${x} out of range (${n} steps)`);
      if (
        (a.kind === "copies-agree" || a.kind === "max-success") &&
        (!s.parallel || parallelStep(s) !== a.step)
      )
        bad(["assertions", i], `${a.kind} needs parallel copies on step ${a.step}`);
    });
  });
export type Scenario = z.output<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;

export function parallelStep(s: Pick<Scenario, "parallel" | "steps">): number | undefined {
  if (!s.parallel) return undefined;
  return s.parallel.step ?? s.steps.length - 1;
}

/** Number of HTTP requests one execution of the scenario sends. */
export function requestCount(s: Pick<Scenario, "setup" | "steps" | "parallel">): number {
  return s.setup.length + s.steps.length + (s.parallel ? s.parallel.copies - 1 : 0);
}

/** Operations a scenario's failure is attributed to (step's operation). */
export function assertionOperation(s: Scenario, a: ScenarioAssertion): string {
  const i = a.kind === "same-json" ? a.steps[1] : a.kind === "no-5xx" ? s.steps.length - 1 : a.step;
  return s.steps[i]?.operation ?? s.steps[0]?.operation ?? "";
}

/**
 * Canonical JSON (sorted keys). Input must be validated first (depth bounded by the validator),
 * so the bounded recursion here never sees user-sized nesting.
 */
export function canonicalJson(v: unknown, depth = 0): string {
  if (depth > 64) return '"…"';
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x, depth + 1)).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k], depth + 1)}`)
    .join(",")}}`;
}

/** Novelty fingerprint: normalised hash of everything that changes behaviour (not title/hypothesis). */
export function scenarioFingerprint(s: Scenario): string {
  return sha256(
    canonicalJson({ setup: s.setup, steps: s.steps, parallel: s.parallel ?? null, assertions: s.assertions }),
  ).slice(0, 32);
}

/** Parses an unknown value; returns readable issues instead of throwing. */
export function parseScenario(
  raw: unknown,
): { ok: true; scenario: Scenario } | { ok: false; errors: string[] } {
  const r = ScenarioSchema.safeParse(raw);
  if (r.success) return { ok: true, scenario: r.data };
  return {
    ok: false,
    errors: zodIssueLines(r.error, { schema: ScenarioSchema })
      .slice(0, 20)
      .map((i) => `${i.path || "(root)"}: ${i.message}`),
  };
}
