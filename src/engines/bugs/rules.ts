/**
 * Rule catalogue of the Bug Hunter: id → category, severity, title template.
 * Severity follows docs/03-engines/evidence-and-history.md §A.2 (auth/data loss → high/critical).
 */
import type { Category, Severity } from "../../core/evidence/schemas.js";

export interface RuleInfo {
  category: Category;
  severity: Severity;
  title: string;
  recommendation: string;
}

export const RULES = {
  "bugs/schema-mismatch": {
    category: "correctness",
    severity: "medium",
    title: "Response does not match the contract schema",
    recommendation: "Fix the serialisation or update the contract so both agree",
  },
  "bugs/content-type-mismatch": {
    category: "correctness",
    severity: "low",
    title: "Response content-type is not the documented one",
    recommendation: "Send the documented media type",
  },
  "bugs/missing-response-header": {
    category: "correctness",
    severity: "low",
    title: "Required response header missing",
    recommendation: "Send the documented header",
  },
  "bugs/undocumented-status": {
    category: "correctness",
    severity: "low",
    title: "Valid request answered with an undocumented status",
    recommendation: "Document the status or fix the handler",
  },
  "bugs/server-error": {
    category: "bug",
    severity: "high",
    title: "Server error (5xx) on a valid request",
    recommendation: "Handle the input; valid requests must get a documented response",
  },
  "bugs/server-error-on-boundary": {
    category: "bug",
    severity: "medium",
    title: "Server error (5xx) on an invalid/boundary value instead of 4xx",
    recommendation: "Validate the input and return 400",
  },
  "bugs/server-error-on-invalid-input": {
    category: "bug",
    severity: "medium",
    title: "Server error (5xx) on a malformed request instead of 4xx",
    recommendation: "Reject malformed requests with 400/415",
  },
  "bugs/accepts-invalid-input": {
    category: "correctness",
    severity: "low",
    title: "Invalid input accepted (2xx)",
    recommendation: "Validate input against the contract",
  },
  "bugs/round-trip-mismatch": {
    category: "correctness",
    severity: "medium",
    title: "Read-after-create returns different data",
    recommendation: "Persist and return the created representation consistently",
  },
  "bugs/idempotency-key-ignored": {
    category: "bug",
    severity: "high",
    title: "Idempotency-Key ignored: repeated request created a new resource",
    recommendation: "Store key → response and replay it for repeated keys",
  },
  "bugs/race-lost-update": {
    category: "bug",
    severity: "high",
    title: "Concurrency invariant violated (race / lost update)",
    recommendation: "Use an atomic conditional update, a lock, or optimistic concurrency",
  },
  "bugs/bola": {
    category: "security",
    severity: "critical",
    title: "BOLA: another user's object is accessible",
    recommendation: "Check object ownership on every access",
  },
  "bugs/bfla": {
    category: "security",
    severity: "critical",
    title: "Broken function-level authorization: privileged operation allowed for a regular user",
    recommendation: "Enforce the required role on the route",
  },
  "bugs/missing-authentication": {
    category: "security",
    severity: "critical",
    title: "Secured operation accessible without valid credentials",
    recommendation: "Require authentication on the route",
  },
  "bugs/state-model-mismatch": {
    category: "bug",
    severity: "high",
    title: "Resource lifecycle deviates from the state model",
    recommendation: "Make the resource follow its documented lifecycle",
  },
  "bugs/assertion-failed": {
    category: "bug",
    severity: "medium",
    title: "Configured assertion failed",
    recommendation: "Fix the behaviour or the assertion",
  },
  "bugs/invariant-violated": {
    category: "bug",
    severity: "high",
    title: "Invariant violated",
    recommendation: "Fix the behaviour so the invariant holds",
  },
  "bugs/server-error-observed": {
    category: "bug",
    severity: "info",
    title: "Server error observed (discovery mode, no contract)",
    recommendation: "Add a contract so the Bug Hunter can classify this",
  },
} as const satisfies Record<string, RuleInfo>;

export type RuleId = keyof typeof RULES;
