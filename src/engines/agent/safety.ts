/**
 * Safety validator — docs/03-engines/adversarial-test-agent.md §5, docs/11-safety-security-privacy.md §2, §6.
 *
 * Runs before EVERY execution, for heuristic and AI proposals alike. It never trusts the
 * planner: a proposal is untrusted data until it passes (1) a raw pre-flight (size, depth,
 * plain JSON only), (2) the strict ScenarioSchema, (3) the semantic policy below. Rejections
 * carry every reason found and are written to the audit trail by `validateProposal`.
 *
 * Policy checks:
 * - operations must exist in the contract (exact "METHOD /path" key); path params must be the
 *   operation's own and must not contain separators / traversal / encoded separators;
 * - no host can be named: there is no URL field, and absolute URLs inside values must point to
 *   allow-listed hosts (blocks SSRF-style payloads such as callback URLs);
 * - roles must be configured test accounts (or anonymous / "$invalid"); credential, hop-by-hop
 *   and routing headers cannot be set; header values cannot contain CR/LF/NUL;
 * - mutating methods need the session's mutation permission; destructive operations (DELETE,
 *   mutating admin/purge/reset-like paths, configured patterns) need explicit approval;
 * - payload size, nesting depth, parallel copies (concurrency limit) and the remaining request
 *   budget are bounded;
 * - `{{var}}` placeholders must reference values extracted by an earlier step.
 */
import type { SafetyGuard } from "../../core/types.js";
import type { Operation } from "../bugs/contract.js";
import { parseScenario, requestCount, type Scenario, type Step } from "./scenario.js";

export interface SafetyPolicy {
  /** Contract operations by canonical key "METHOD /path". */
  operations: ReadonlyMap<string, Operation>;
  /** Configured test-account role names. */
  roles: readonly string[];
  /** Header names that carry credentials of configured roles (type "header"). */
  credentialHeaders?: readonly string[];
  /** Hosts that absolute URLs inside values may point to (target host + safety allowHosts). */
  allowedHosts: readonly string[];
  mutationsAllowed: boolean;
  destructiveAllowed: boolean;
  /** Extra destructive operation patterns ("DELETE /x/*", "POST /admin/*"). */
  destructivePatterns?: readonly string[];
  /** Max serialised scenario size in bytes. Default 64 KiB. */
  maxPayloadBytes?: number;
  /** Max parallel copies (concurrency limit). */
  maxCopies: number;
  /** Max JSON nesting depth. Default 16. */
  maxDepth?: number;
  /** Requests still available in the budget; undefined = unlimited. */
  remainingRequests?: number;
}

export type ValidationResult =
  | { ok: true; scenario: Scenario }
  | { ok: false; reasons: string[]; title?: string };

const DENIED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "expect",
  "forwarded",
  "x-real-ip",
  "x-original-url",
  "x-rewrite-url",
  "x-http-method-override",
  "x-method-override",
  "x-http-method",
  "x-api-key",
]);
const DESTRUCTIVE_PATH = /(^|\/)(admin|purge|wipe|drop|truncate|reset|shutdown|destroy|__\w+)(\/|$)/i;
const URL_RE = /([a-z][a-z0-9+.-]{0,20}):\/\/([^/\s?#"'<>\\]*)/gi;
const PROTO_RELATIVE = /^\s*\/\/[^/]/;
/** Control characters (C0 + DEL), checked by char code. */
const CTRL = {
  test(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
  },
};
const VAR_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

export function normalizeOperationKey(s: string): string {
  const [m, ...rest] = s.trim().split(/\s+/);
  return `${(m ?? "").toUpperCase()} ${rest.join(" ")}`;
}

export function matchesOpPattern(op: Operation, pattern: string): boolean {
  const [m, ...rest] = pattern.trim().split(/\s+/);
  const p = rest.join(" ");
  if (!m || (m !== "*" && m.toUpperCase() !== op.method)) return false;
  const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return re.test(op.path);
}

export function isDestructive(op: Operation, patterns: readonly string[] = []): boolean {
  if (op.method === "DELETE") return true;
  if (patterns.some((p) => matchesOpPattern(op, p))) return true;
  return op.mutating && DESTRUCTIVE_PATH.test(op.path);
}

function hostOf(authority: string): string {
  const noUser = authority.slice(authority.lastIndexOf("@") + 1);
  if (noUser.startsWith("[")) return noUser.slice(1, noUser.indexOf("]")).toLowerCase();
  return (noUser.split(":")[0] ?? "").toLowerCase();
}

/** Raw pre-flight on an unknown value: plain JSON only, bounded depth/size, no cycles. Iterative. */
export function preflightRaw(raw: unknown, maxDepth: number, maxBytes: number): string[] {
  const reasons: string[] = [];
  let size: number;
  try {
    const s = JSON.stringify(raw);
    if (s === undefined) return ["proposal is not JSON data"];
    size = Buffer.byteLength(s, "utf8");
  } catch {
    return ["proposal is not serialisable JSON (cycle or non-JSON value)"];
  }
  if (size > maxBytes) reasons.push(`payload ${size} bytes exceeds the limit of ${maxBytes} bytes`);
  const stack: [unknown, number][] = [[raw, 0]];
  let nodes = 0;
  while (stack.length > 0) {
    const [v, d] = stack.pop() as [unknown, number];
    if (++nodes > 200_000) {
      reasons.push("proposal has too many nodes");
      break;
    }
    if (v === null || typeof v !== "object") {
      if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint")
        reasons.push("proposal contains a non-JSON value");
      continue;
    }
    if (d >= maxDepth) {
      reasons.push(`nesting deeper than ${maxDepth}`);
      break;
    }
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) {
      reasons.push("proposal contains a non-plain object");
      break;
    }
    for (const k of Object.keys(v)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        reasons.push(`forbidden key "${k}"`);
        continue;
      }
      stack.push([(v as Record<string, unknown>)[k], d + 1]);
    }
  }
  return [...new Set(reasons)];
}

/** Every string in a JSON value (iterative). */
function strings(v: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (typeof x === "string") out.push(x);
    else if (Array.isArray(x)) stack.push(...x);
    else if (x !== null && typeof x === "object") {
      for (const [k, y] of Object.entries(x)) {
        out.push(k);
        stack.push(y);
      }
    }
  }
  return out;
}

function checkUrls(s: string, allowed: ReadonlySet<string>, where: string, reasons: string[]): void {
  URL_RE.lastIndex = 0;
  for (const m of s.matchAll(URL_RE)) {
    const host = hostOf(m[2] ?? "");
    if (!allowed.has(host)) reasons.push(`${where}: references foreign host "${host || m[0]}"`);
  }
  if (PROTO_RELATIVE.test(s)) reasons.push(`${where}: protocol-relative URL`);
}

function checkPathValue(v: string, where: string, reasons: string[]): void {
  const low = v.toLowerCase();
  if (/[/\\]/.test(v) || v === "." || v.includes("..") || /%(2e|2f|5c|00)/i.test(low) || CTRL.test(v))
    reasons.push(`${where}: path traversal / separator in path parameter`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^\{\{/.test(v))
    reasons.push(`${where}: URL scheme in path parameter`);
}

function checkStep(
  st: Step,
  where: string,
  p: SafetyPolicy,
  defined: Set<string>,
  allowedHosts: ReadonlySet<string>,
  reasons: string[],
): void {
  const key = normalizeOperationKey(st.operation);
  const op = p.operations.get(key);
  if (!op) {
    reasons.push(`${where}: unknown operation "${st.operation}" (not in the contract)`);
  } else {
    if (op.mutating && !p.mutationsAllowed)
      reasons.push(
        `${where}: ${op.method} not permitted in this environment (mutations not allowed/approved)`,
      );
    if (isDestructive(op, p.destructivePatterns) && !p.destructiveAllowed)
      reasons.push(`${where}: destructive operation ${op.key} requires approval`);
    const names = new Set([...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string));
    for (const n of Object.keys(st.pathParams ?? {}))
      if (!names.has(n)) reasons.push(`${where}: path parameter "${n}" is not part of ${op.path}`);
    for (const n of names)
      if (st.pathParams?.[n] === undefined) reasons.push(`${where}: missing path parameter "${n}"`);
  }
  for (const [n, v] of Object.entries(st.pathParams ?? {}))
    if (typeof v === "string") checkPathValue(v, `${where}.pathParams.${n}`, reasons);
  if (st.role !== undefined && st.role !== null && st.role !== "$invalid" && !p.roles.includes(st.role))
    reasons.push(`${where}: role "${st.role}" is not a configured test account`);
  const credHeaders = new Set((p.credentialHeaders ?? []).map((h) => h.toLowerCase()));
  for (const [h, v] of Object.entries(st.headers ?? {})) {
    const hl = h.toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/i.test(h)) reasons.push(`${where}: invalid header name "${h}"`);
    if (DENIED_HEADERS.has(hl) || hl.startsWith("x-forwarded-") || credHeaders.has(hl))
      reasons.push(`${where}: header "${h}" may not be set (credentials/routing come from configuration)`);
    if (CTRL.test(v)) reasons.push(`${where}: control characters in header "${h}"`);
  }
  for (const [k, v] of Object.entries(st.query ?? {})) {
    if (CTRL.test(k)) reasons.push(`${where}: control characters in query name`);
    for (const x of Array.isArray(v) ? v : [v])
      if (
        typeof x === "string" &&
        (x.includes("\r") || x.includes("\n") || x.includes(String.fromCharCode(0)))
      )
        reasons.push(`${where}: CR/LF/NUL in query "${k}"`);
  }
  // Absolute URLs anywhere in values.
  const all = [
    ...strings(st.pathParams ?? {}),
    ...strings(st.query ?? {}),
    ...strings(st.headers ?? {}),
    ...strings(st.body ?? null),
  ];
  for (const s of all) checkUrls(s, allowedHosts, where, reasons);
  // Variables must be defined by an earlier extract (or $nonce).
  for (const s of all) {
    VAR_RE.lastIndex = 0;
    for (const m of s.matchAll(VAR_RE)) {
      const name = m[1] ?? "";
      if (name !== "$nonce" && !defined.has(name)) reasons.push(`${where}: undefined variable {{${name}}}`);
    }
  }
  for (const v of Object.keys(st.extract ?? {})) defined.add(v);
}

/** Semantic policy checks on a schema-valid scenario. Returns all reasons (empty = allowed). */
export function checkScenario(s: Scenario, p: SafetyPolicy): string[] {
  const reasons: string[] = [];
  const allowedHosts = new Set(p.allowedHosts.map((h) => h.toLowerCase().replace(/^\[|\]$/g, "")));
  const defined = new Set<string>();
  for (const [i, st] of s.setup.entries()) checkStep(st, `setup[${i}]`, p, defined, allowedHosts, reasons);
  for (const [i, st] of s.steps.entries()) checkStep(st, `steps[${i}]`, p, defined, allowedHosts, reasons);
  if (s.parallel && s.parallel.copies > p.maxCopies)
    reasons.push(`parallel copies ${s.parallel.copies} exceed the concurrency limit ${p.maxCopies}`);
  const n = requestCount(s);
  if (p.remainingRequests !== undefined && n > p.remainingRequests)
    reasons.push(`scenario needs ${n} requests but only ${p.remainingRequests} remain in the budget`);
  return [...new Set(reasons)];
}

/**
 * Full validation of an untrusted proposal (raw JSON or a Scenario object). Every rejection is
 * audited (`agent.scenario.rejected`).
 */
export function validateProposal(
  raw: unknown,
  p: SafetyPolicy,
  audit?: SafetyGuard["audit"],
  source = "heuristic",
): ValidationResult {
  const maxBytes = p.maxPayloadBytes ?? 64 * 1024;
  const maxDepth = p.maxDepth ?? 16;
  const title =
    raw !== null && typeof raw === "object" && typeof (raw as { title?: unknown }).title === "string"
      ? (raw as { title: string }).title.slice(0, 200)
      : undefined;
  const reject = (reasons: string[]): ValidationResult => {
    audit?.({
      action: "agent.scenario.rejected",
      detail: { source, ...(title === undefined ? {} : { title }), reasons: reasons.slice(0, 20) },
    });
    return title === undefined ? { ok: false, reasons } : { ok: false, reasons, title };
  };
  const pre = preflightRaw(raw, maxDepth, maxBytes);
  if (pre.length > 0) return reject(pre);
  const parsed = parseScenario(raw);
  if (!parsed.ok) return reject(parsed.errors.map((e) => `schema: ${e}`));
  const reasons = checkScenario(parsed.scenario, p);
  if (reasons.length > 0) return reject(reasons);
  return { ok: true, scenario: parsed.scenario };
}
