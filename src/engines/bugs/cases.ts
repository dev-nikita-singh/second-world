/**
 * Replayable test cases and their evaluation (docs/03-engines/api-bug-hunter.md §3 steps 2–3).
 *
 * A BugCase is pure data (JSON-serialisable): request templates referencing roles by name
 * (never secrets), `{{var}}` substitution from values extracted in earlier steps, and an explicit
 * check. The same `runCase` is used for discovery, replays, minimisation and `sw replay`, so a
 * failure means the same thing every time.
 */

import { fingerprint } from "../../shared/util/fingerprint.js";
import {
  type Contract,
  isJsonMedia,
  matchesPattern,
  matchResponse,
  mediaTypeMatches,
  type Operation,
} from "./contract.js";
import { type Dictionary, pathParamNames } from "./dictionary.js";
import { type BugsHttp, type Exchange, jsonAt, type RequestTemplate, substitute } from "./http.js";
import {
  type BuiltinInvariant,
  type ConcurrencyContext,
  checkBuiltin,
  checkMixed,
  invariantMessage,
  type LoadedInvariant,
  toInvariantExchange,
} from "./invariants.js";
import { getPointer, isObject, jsonType } from "./json-schema.js";
import { RULES, type RuleId } from "./rules.js";
import type { Assertion, ConcurrencyTest, Technique } from "./schema.js";
import { normalizePointer } from "./validator.js";

export type StepExpect =
  | "valid"
  | "invalid"
  | "any"
  | "none"
  | { status: number[]; rule?: RuleId; message?: string };

export interface MixStep {
  request: RequestTemplate;
  count: number;
  phase: "before" | "during" | "after";
  /** Index into the concurrency test's `mix`. */
  tag: number;
}

export interface CaseStep {
  request: RequestTemplate;
  /** var name → JSON pointer into the response body. */
  extract?: Record<string, string>;
  /** Send `burst` identical copies concurrently behind a barrier. */
  burst?: number;
  /** Mixed-operation concurrency: other requests sent before / inside / after the burst. */
  mix?: MixStep[];
  expect: StepExpect;
  /** Expected JSON values (after substitution) — used by model-based steps. */
  /** `ifPresent`: a field the response does not contain is a different representation, not a mismatch. */
  expectJson?: { pointer: string; equals: unknown; ifPresent?: boolean }[];
  /** Pointer of the varied input (for 5xx-on-invalid findings), e.g. "/qty" or "query:limit". */
  inputPointer?: string;
  label?: string;
  /** Model-based steps: the command, so expectations can be recomputed for any subsequence (ddmin). */
  model?: {
    cmd: "create" | "read" | "update" | "delete";
    v: string;
    fields?: Record<string, unknown>;
    /** JSON pointer of the object that holds the resource in a read response ("" = the body itself). */
    base?: string;
  };
}

/** Escapes one JSON-pointer segment (RFC 6901). */
function ptrSeg(k: string): string {
  return k.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Read-back expectations of a model-based step: every field the model knows, under `base` (the response
 * envelope, e.g. "/transaction" when the id is at "/transaction/id"). Only fields the response contains are
 * compared: an API may return a field in another shape (`categoryId` → `category: { id }`).
 */
export function modelReadExpectations(
  fields: Record<string, unknown>,
  base = "",
): NonNullable<CaseStep["expectJson"]> {
  return Object.entries(fields).map(([k, equals]) => ({
    pointer: `${base}/${ptrSeg(k)}`,
    equals,
    ifPresent: true,
  }));
}

/** The envelope of a resource from its id pointer: "/transaction/id" → "/transaction", "/id" → "". */
export function envelopeOf(idPointer: string): string {
  const i = idPointer.lastIndexOf("/");
  return i <= 0 ? "" : idPointer.slice(0, i);
}

const MODEL_OK = { create: [200, 201], read: [200], update: [200, 204], delete: [200, 202, 204] } as const;

/**
 * Recomputes status/JSON expectations of model-based steps by simulating the sequential model on
 * exactly these steps, so a removed `delete` changes what a later `read` must return.
 */
export function rebuildModelExpectations(steps: CaseStep[]): CaseStep[] {
  const live = new Map<string, Record<string, unknown>>();
  const deleted = new Set<string>();
  return steps.map((st) => {
    const m = st.model;
    if (!m) return st;
    const out: CaseStep = { ...st };
    delete out.expectJson;
    const gone = deleted.has(m.v);
    if (m.cmd === "create") {
      live.set(m.v, { ...(m.fields ?? {}) });
      out.expect = { status: [...MODEL_OK.create], message: `create ${m.v} failed` };
    } else if (gone) {
      out.expect = {
        status: [404, 410],
        message:
          m.cmd === "read"
            ? `deleted resource ${m.v} is still readable`
            : `${m.cmd} on deleted resource ${m.v} did not answer 404/410`,
      };
    } else if (m.cmd === "read") {
      out.expect = { status: [...MODEL_OK.read], message: `existing resource ${m.v} not readable` };
      out.expectJson = modelReadExpectations(live.get(m.v) ?? {}, m.base ?? "");
    } else if (m.cmd === "update") {
      out.expect = { status: [...MODEL_OK.update], message: `update ${m.v} failed` };
      live.set(m.v, { ...(live.get(m.v) ?? {}), ...(m.fields ?? {}) });
    } else {
      out.expect = { status: [...MODEL_OK.delete], message: `delete ${m.v} failed` };
      live.delete(m.v);
      deleted.add(m.v);
    }
    return out;
  });
}

export type Check =
  | { kind: "conformance" }
  | {
      kind: "denied";
      step: number;
      rule: "bugs/bola" | "bugs/bfla" | "bugs/missing-authentication";
      detail: string;
    }
  | { kind: "idempotent"; pointer: string }
  | { kind: "round-trip"; create: number; read: number }
  | { kind: "concurrency"; test: number }
  | { kind: "model" };

export interface BugCase {
  id: string;
  technique: Technique | "discovery";
  operation: string;
  label: string;
  seed: number;
  steps: CaseStep[];
  check: Check;
  /** Self-contained replay context (embedded in reproduction artifacts; see artifact.ts). */
  context?: CaseContext;
}

/**
 * Everything a replay needs besides target/credentials, so `sw replay` never depends on the
 * original config: the concurrency test spec, assertions and invariant module refs (absolute
 * paths), role names used (written into the steps) and whether the contract is required.
 */
export interface CaseContext {
  version: 1;
  contract?: { source: string; hash: string; required: boolean };
  roles: string[];
  assertions: Assertion[];
  invariants: { module: string; export?: string; operations?: string[]; name?: string }[];
  concurrency?: ConcurrencyTest;
}

export interface Failure {
  ruleId: RuleId;
  operation: string;
  /** Pointer used in the fingerprint (response pointer, input pointer or check-specific key). */
  pointer: string;
  keyword: string;
  message: string;
  step: number;
  status: number;
  observation: boolean;
  fingerprint: string;
}

export interface CaseRun {
  failures: Failure[];
  exchanges: Exchange[];
  inconclusive: boolean;
  reason?: string;
  /** Per-step primary exchange (for matrices). */
  stepExchanges: (Exchange | undefined)[];
  /** Per-step request actually sent ({{vars}} substituted with recorded values), for reproductions. */
  requests: (RequestTemplate | undefined)[];
}

export interface EvalEnv {
  http: BugsHttp;
  contract?: Contract;
  opsByKey: Map<string, Operation>;
  assertions: Assertion[];
  invariants: LoadedInvariant[];
  concurrency: ConcurrencyTest[];
  /** Loaded custom concurrency invariants by test index. */
  concurrencyFns: Map<number, LoadedInvariant>;
  dict?: Dictionary;
}

export function failureFingerprint(
  ruleId: string,
  operation: string,
  pointer: string,
  keyword: string,
): string {
  return fingerprint(["bugs", ruleId, operation, normalizePointer(pointer), keyword]);
}

function mkFailure(
  ruleId: RuleId,
  operation: string,
  pointer: string,
  keyword: string,
  message: string,
  step: number,
  status: number,
  observation = false,
): Failure {
  return {
    ruleId,
    operation,
    pointer,
    keyword,
    message,
    step,
    status,
    observation,
    fingerprint: failureFingerprint(ruleId, operation, pointer, keyword),
  };
}

const is2xx = (s: number): boolean => s >= 200 && s < 300;

/** Contract conformance of one exchange given the expectation for its request. */
export function conformance(
  op: Operation,
  ex: Exchange,
  expect: StepExpect,
  step: number,
  inputPointer: string | undefined,
  contract: Contract,
): Failure[] {
  const out: Failure[] = [];
  if (expect === "none") return out;
  const status = ex.status;
  const resp = matchResponse(op, status);
  if (typeof expect === "object") {
    if (!expect.status.includes(status)) {
      out.push(
        mkFailure(
          expect.rule ?? "bugs/state-model-mismatch",
          op.key,
          `status:${expect.status.join("|")}`,
          "status",
          expect.message ?? `expected status ${expect.status.join("/")} but got ${status}`,
          step,
          status,
        ),
      );
    }
    return out;
  }
  if (status >= 500 && !resp) {
    if (expect === "invalid") {
      const field = inputPointer !== undefined && !inputPointer.startsWith("body:");
      out.push(
        mkFailure(
          field ? "bugs/server-error-on-boundary" : "bugs/server-error-on-invalid-input",
          op.key,
          inputPointer ?? "",
          "status",
          `invalid input${inputPointer ? ` at ${inputPointer}` : ""} answered with ${status} (expected 4xx)`,
          step,
          status,
        ),
      );
    } else
      out.push(
        mkFailure(
          "bugs/server-error",
          op.key,
          "",
          "status",
          `valid request answered with ${status}`,
          step,
          status,
        ),
      );
    return out;
  }
  if (expect === "invalid") {
    if (is2xx(status)) {
      out.push(
        mkFailure(
          "bugs/accepts-invalid-input",
          op.key,
          inputPointer ?? "",
          "validation",
          `invalid input${inputPointer ? ` at ${inputPointer}` : ""} accepted with ${status}`,
          step,
          status,
          true,
        ),
      );
    }
    return out;
  }
  if (!resp) {
    if (expect === "valid" && status >= 100) {
      // 413/414/431: transport size limits of the server/framework, not contract behaviour.
      const sizeLimit = status === 413 || status === 414 || status === 431;
      out.push(
        mkFailure(
          "bugs/undocumented-status",
          op.key,
          `status:${status}`,
          "status",
          `valid request answered with undocumented status ${status}${sizeLimit ? " (server size limit)" : ""}`,
          step,
          status,
          sizeLimit,
        ),
      );
    }
    return out;
  }
  // Documented response: media type, headers, body schema.
  const body = ex.responseBody ?? "";
  const types = Object.keys(resp.content);
  if (types.length > 0 && body.length > 0 && status !== 204) {
    const ct = ex.contentType;
    const matched = types.find((t) => mediaTypeMatches(t, ct || "application/octet-stream"));
    if (!matched) {
      out.push(
        mkFailure(
          "bugs/content-type-mismatch",
          op.key,
          "content-type",
          "content-type",
          `content-type "${ct}" not in [${types.join(", ")}]`,
          step,
          status,
        ),
      );
    } else {
      const media = resp.content[matched];
      if (media?.schema !== undefined && isJsonMedia(matched)) {
        if (ex.json === undefined) {
          out.push(
            mkFailure(
              "bugs/schema-mismatch",
              op.key,
              "",
              "json",
              "response body is not valid JSON",
              step,
              status,
            ),
          );
        } else {
          for (const v of contract.validators.validate(media.schema, ex.json)) {
            out.push(
              mkFailure(
                "bugs/schema-mismatch",
                op.key,
                v.pointer,
                v.keyword,
                `${v.message} (value ${preview(getPointer(ex.json, v.instancePath))})`,
                step,
                status,
              ),
            );
          }
        }
      }
    }
  }
  for (const h of resp.headers) {
    if (h.required && ex.responseHeaders[h.name] === undefined) {
      out.push(
        mkFailure(
          "bugs/missing-response-header",
          op.key,
          `header:${h.name}`,
          "required",
          `required header ${h.name} missing`,
          step,
          status,
        ),
      );
    }
  }
  return out;
}

function preview(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function checkAssertion(a: Assertion, ex: Exchange, op: Operation, step: number): Failure[] {
  if (!matchesPattern(op, a.operation)) return [];
  const when = a.when ?? null;
  if (when ? !when.includes(ex.status) : !is2xx(ex.status) && a.status === undefined) return [];
  const name = a.name ?? a.operation;
  const out: Failure[] = [];
  const fail = (key: string, msg: string): void => {
    out.push(
      mkFailure(
        "bugs/assertion-failed",
        op.key,
        `assert:${name}:${key}`,
        "assertion",
        `${name}: ${msg}`,
        step,
        ex.status,
      ),
    );
  };
  if (a.status !== undefined) {
    const allowed = Array.isArray(a.status) ? a.status : [a.status];
    if (!allowed.includes(ex.status)) fail("status", `status ${ex.status} not in [${allowed.join(", ")}]`);
  }
  for (const [h, re] of Object.entries(a.headers ?? {})) {
    const v = ex.responseHeaders[h.toLowerCase()];
    if (v === undefined || !new RegExp(re).test(v))
      fail(`header:${h}`, `header ${h}=${v ?? "(missing)"} does not match /${re}/`);
  }
  for (const j of a.json) {
    const v = getPointer(ex.json, j.pointer);
    if (j.exists !== undefined && (v !== undefined) !== j.exists)
      fail(j.pointer, `${j.pointer} ${j.exists ? "missing" : "present"}`);
    if (j.equals !== undefined && JSON.stringify(v) !== JSON.stringify(j.equals))
      fail(j.pointer, `${j.pointer}=${preview(v)} != ${preview(j.equals)}`);
    if (j.type !== undefined && v !== undefined) {
      const t = jsonType(v);
      if (!(t === j.type || (j.type === "number" && t === "integer")))
        fail(j.pointer, `${j.pointer} is ${t}, expected ${j.type}`);
    }
    if (j.matches !== undefined && (typeof v !== "string" || !new RegExp(j.matches).test(v)))
      fail(j.pointer, `${j.pointer}=${preview(v)} does not match /${j.matches}/`);
  }
  if (a.maxDuration !== undefined && ex.durationMs > a.maxDuration)
    fail("duration", `took ${ex.durationMs.toFixed(1)} ms > ${a.maxDuration} ms`);
  return out;
}

async function checkInvariants(env: EvalEnv, ex: Exchange, op: Operation, step: number): Promise<Failure[]> {
  const out: Failure[] = [];
  for (const inv of env.invariants) {
    if (inv.operations && !inv.operations.some((p) => matchesPattern(op, p))) continue;
    let msg: string | null;
    try {
      msg = invariantMessage(await inv.fn(toInvariantExchange(ex)));
    } catch (e) {
      msg = `invariant threw: ${(e as Error).message}`;
    }
    if (msg)
      out.push(
        mkFailure(
          inv.kind === "assertion" ? "bugs/assertion-failed" : "bugs/invariant-violated",
          op.key,
          `${inv.kind === "assertion" ? "assert" : "invariant"}:${inv.name}`,
          inv.kind === "assertion" ? "assertion" : "invariant",
          `${inv.name}: ${msg}`,
          step,
          ex.status,
        ),
      );
  }
  return out;
}

/** Deep comparison of two JSON values on keys present in both; returns differing pointers. */
export function diffCommon(a: unknown, b: unknown, base = "", out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 20) return out;
  if (isObject(a) && isObject(b)) {
    for (const k of Object.keys(a))
      if (k in b)
        diffCommon(a[k], b[k], `${base}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, out, depth + 1);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(base);
      return out;
    }
    for (let i = 0; i < a.length; i++) diffCommon(a[i], b[i], `${base}/${i}`, out, depth + 1);
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(base);
  return out;
}

const VOLATILE_KEY = /(updated|modified|lastSeen|etag|version|expires|timestamp)/i;

export async function runCase(c0: BugCase, env: EvalEnv): Promise<CaseRun> {
  const c = c0.check.kind === "model" ? { ...c0, steps: rebuildModelExpectations(c0.steps) } : c0;
  const scope: Record<string, unknown> = {};
  const exchanges: Exchange[] = [];
  const stepExchanges: (Exchange | undefined)[] = [];
  const requests: (RequestTemplate | undefined)[] = [];
  const failures: Failure[] = [];
  const result = (inconclusive: boolean, reason?: string): CaseRun => {
    const r: CaseRun = {
      failures: inconclusive ? [] : failures,
      exchanges,
      inconclusive,
      stepExchanges,
      requests,
    };
    if (reason !== undefined) r.reason = reason;
    return r;
  };
  for (let i = 0; i < c.steps.length; i++) {
    const step = c.steps[i] as CaseStep;
    const missing = new Set<string>();
    const tpl = substitute(step.request, scope, missing);
    if (missing.size > 0) return result(true, `unresolved variables: ${[...missing].join(", ")}`);
    requests[i] = tpl;
    const op = env.opsByKey.get(tpl.operation);
    if (
      c.check.kind === "conformance" &&
      (step.expect === "valid" || step.expect === "invalid" || step.expect === "any") &&
      (!op || !env.contract)
    ) {
      return result(true, `contract operation ${tpl.operation} unavailable: conformance cannot be checked`);
    }
    if (step.burst && step.burst > 1) {
      const mix = (step.mix ?? []).map((m) => ({ ...m, request: substitute(m.request, scope, missing) }));
      if (missing.size > 0) return result(true, `unresolved variables: ${[...missing].join(", ")}`);
      const all: Exchange[] = [];
      const tags: number[] = [];
      const sequential = async (phase: "before" | "after"): Promise<void> => {
        for (const m of mix)
          if (m.phase === phase)
            for (let k = 0; k < m.count; k++) {
              all.push(await env.http.send(m.request));
              tags.push(m.tag);
            }
      };
      await sequential("before");
      const tpls: RequestTemplate[] = Array.from({ length: step.burst }, () => tpl);
      const btags: number[] = tpls.map(() => -1);
      for (const m of mix)
        if (m.phase === "during")
          for (let k = 0; k < m.count; k++) {
            tpls.push(m.request);
            btags.push(m.tag);
          }
      const fired = await env.http.burst(tpls);
      all.push(...fired);
      tags.push(...btags);
      await sequential("after");
      const burst = all.filter((_, k) => tags[k] === -1);
      exchanges.push(...all);
      stepExchanges.push(burst[0]);
      if (all.some((e) => e.blocked)) return result(true, all.find((e) => e.blocked)?.error);
      if (c.check.kind === "concurrency") {
        const f = await evalConcurrency(c, env, burst, i, mix.length > 0 ? { all, tags } : undefined);
        if (f === "inconclusive")
          return result(
            true,
            "concurrency check unresolved (test/invariant missing) or all burst requests failed",
          );
        failures.push(...f);
      }
      continue;
    }
    const ex = await env.http.send(tpl);
    exchanges.push(ex);
    stepExchanges.push(ex);
    if (ex.blocked) return result(true, ex.error);
    if (ex.error) return result(true, `transport error: ${ex.error}`);
    if (
      is2xx(ex.status) &&
      env.dict &&
      ex.json !== undefined &&
      (tpl.method === "GET" || tpl.method === "POST")
    ) {
      env.dict.harvest(op?.path ?? tpl.path, ex.json, env.contract ? pathParamNames(env.contract) : []);
    }
    for (const [name, ptr] of Object.entries(step.extract ?? {})) {
      const v = jsonAt(ex, ptr);
      if (v !== undefined) scope[name] = v;
    }
    if (op && env.contract)
      failures.push(...conformance(op, ex, step.expect, i, step.inputPointer, env.contract));
    else if (typeof step.expect === "object" && !step.expect.status.includes(ex.status)) {
      failures.push(
        mkFailure(
          step.expect.rule ?? "bugs/state-model-mismatch",
          tpl.operation,
          `status:${step.expect.status.join("|")}`,
          "status",
          step.expect.message ?? `expected ${step.expect.status.join("/")} got ${ex.status}`,
          i,
          ex.status,
        ),
      );
    }
    if (step.expectJson && ex.json !== undefined) {
      for (const e of step.expectJson) {
        const m2 = new Set<string>();
        const want = substitute(e.equals, scope, m2);
        const got = getPointer(ex.json, e.pointer);
        if (got === undefined && e.ifPresent) continue;
        if (m2.size === 0 && JSON.stringify(got) !== JSON.stringify(want)) {
          failures.push(
            mkFailure(
              "bugs/state-model-mismatch",
              tpl.operation,
              `json:${e.pointer}`,
              "model",
              `${e.pointer}=${preview(got)}, model expects ${preview(want)}`,
              i,
              ex.status,
            ),
          );
        }
      }
    }
    if (op) {
      for (const a of env.assertions) failures.push(...checkAssertion(a, ex, op, i));
      if (env.invariants.length > 0) failures.push(...(await checkInvariants(env, ex, op, i)));
    }
  }
  // Check-specific evaluation.
  const chk = c.check;
  if (chk.kind === "denied") {
    const ex = stepExchanges[chk.step];
    if (!ex) return result(true, "denied step missing");
    // The positive control steps (e.g. owner create) must have succeeded.
    for (let s = 0; s < chk.step; s++) {
      const e = stepExchanges[s];
      if (!e || !is2xx(e.status))
        return result(true, `precondition step ${s} answered ${e?.status ?? "nothing"}`);
    }
    // Only the authorization violation counts for this case (conformance is checked elsewhere).
    failures.length = 0;
    if (is2xx(ex.status)) {
      failures.push(
        mkFailure(
          chk.rule,
          c.operation,
          `auth:${ex.role ?? "anonymous"}`,
          "authorization",
          `${chk.detail}: got ${ex.status}`,
          chk.step,
          ex.status,
        ),
      );
    }
  } else if (chk.kind === "idempotent") {
    const [a, b] = [stepExchanges[0], stepExchanges[1]];
    if (!a || !b || !is2xx(a.status)) return result(true, "first request did not succeed");
    if (is2xx(b.status)) {
      const va = jsonAt(a, chk.pointer);
      const vb = jsonAt(b, chk.pointer);
      if (va !== undefined && JSON.stringify(va) !== JSON.stringify(vb)) {
        failures.push(
          mkFailure(
            "bugs/idempotency-key-ignored",
            c.operation,
            chk.pointer,
            "idempotency",
            `same Idempotency-Key returned ${chk.pointer}=${preview(va)} then ${preview(vb)}`,
            1,
            b.status,
          ),
        );
      }
    }
  } else if (chk.kind === "round-trip") {
    const a = stepExchanges[chk.create];
    const b = stepExchanges[chk.read];
    if (!a || !b || !is2xx(a.status)) return result(true, "create did not succeed");
    if (is2xx(b.status) && a.json !== undefined && b.json !== undefined) {
      const flagged = new Set(
        failures.filter((f) => f.ruleId === "bugs/schema-mismatch").map((f) => f.pointer),
      );
      for (const p of diffCommon(a.json, b.json)) {
        const np = normalizePointer(p);
        if ([...flagged].some((f) => np === f || np.startsWith(`${f}/`) || f.startsWith(`${np}/`))) continue;
        if (VOLATILE_KEY.test(p)) continue;
        failures.push(
          mkFailure(
            "bugs/round-trip-mismatch",
            c.operation,
            np,
            "round-trip",
            `${p}: created ${preview(getPointer(a.json, p))}, read back ${preview(getPointer(b.json, p))}`,
            chk.read,
            b.status,
          ),
        );
      }
    } else if (!is2xx(b.status)) {
      failures.push(
        mkFailure(
          "bugs/round-trip-mismatch",
          c.operation,
          "status",
          "round-trip",
          `created resource cannot be read back (status ${b.status})`,
          chk.read,
          b.status,
        ),
      );
    }
  }
  return result(false);
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const methodOf = (key: string): string => (key.trim().split(/\s+/)[0] ?? "").toUpperCase();

/**
 * Operation a lost-update finding is attributed to: the test's main operation, unless that is a
 * read (a burst of GETs observing a counter) and the `mix` holds a mutating operation; then the
 * first mutating mix operation, where the lost update happens (conduit: POST …/favorite).
 */
function raceOperation(main: string, test: ConcurrencyTest, env: EvalEnv): string {
  if (!READ_METHODS.has(methodOf(main))) return main;
  for (const m of test.mix) {
    const key = env.opsByKey.get(normalizeOpKey(m.operation))?.key ?? m.operation.trim();
    if (!READ_METHODS.has(methodOf(key))) return key;
  }
  return main;
}

async function evalConcurrency(
  c: BugCase,
  env: EvalEnv,
  burst: Exchange[],
  step: number,
  mixed?: { all: Exchange[]; tags: number[] },
): Promise<Failure[] | "inconclusive"> {
  if (c.check.kind !== "concurrency") return [];
  const test = env.concurrency[c.check.test];
  // Fail safe: a check that cannot be resolved must never "pass".
  if (!test) return "inconclusive";
  if (burst.every((e) => e.error)) return "inconclusive";
  const out: Failure[] = [];
  const statuses = burst.map((e) => e.status);
  const summary = `statuses [${statuses.join(", ")}]`;
  const inv = test.invariant;
  const name = test.name ?? `${c.operation} x${burst.length}`;
  const raceOp = raceOperation(c.operation, test, env);
  if (inv !== undefined && typeof inv === "object" && "kind" in inv) {
    const r =
      mixed && inv.kind === "linearizable"
        ? checkMixed(inv as BuiltinInvariant & { kind: "linearizable" }, test, mixed.all, mixed.tags)
        : checkBuiltin(inv as BuiltinInvariant, burst);
    if (r.message)
      out.push(
        mkFailure(
          "bugs/race-lost-update",
          raceOp,
          `concurrency:${name}`,
          inv.kind,
          `${r.message}; ${summary}`,
          step,
          statuses.find(is2xx) ?? statuses[0] ?? 0,
        ),
      );
  } else if (inv !== undefined) {
    const fn = env.concurrencyFns.get(c.check.test);
    if (!fn) return "inconclusive";
    {
      const cctx: ConcurrencyContext = {
        operation: c.operation,
        responses: burst.map(toInvariantExchange),
        ...(mixed
          ? {
              mixed: mixed.all.map((e, k) => ({
                ...toInvariantExchange(e),
                tag: mixed.tags[k] as number,
                tStart: e.tStart,
                tEnd: e.tEnd,
              })),
            }
          : {}),
        get: async (path: string) => {
          const ex = await env.http.send({
            operation: "",
            method: "GET",
            path,
            pathParams: {},
            query: {},
            headers: {},
            body: { kind: "none" },
            secured: true,
          });
          return { status: ex.status, body: ex.json ?? ex.responseBody };
        },
      };
      let msg: string | null;
      try {
        msg = invariantMessage(await fn.fn(cctx));
      } catch (e) {
        msg = `invariant threw: ${(e as Error).message}`;
      }
      if (msg)
        out.push(
          mkFailure(
            "bugs/race-lost-update",
            raceOp,
            `concurrency:${name}`,
            "invariant",
            `${fn.name}: ${msg}; ${summary}`,
            step,
            statuses[0] ?? 0,
          ),
        );
    }
  }
  if (test.postState) {
    const ps = test.postState;
    const op = env.opsByKey.get(normalizeOpKey(ps.operation));
    const [m, ...rest] = ps.operation.trim().split(/\s+/);
    const ex = await env.http.send({
      operation: op?.key ?? ps.operation,
      method: (m ?? "GET").toUpperCase(),
      path: op?.path ?? rest.join(" "),
      pathParams: ps.pathParams,
      query: {},
      headers: {},
      body: { kind: "none" },
      secured: op?.secured ?? true,
      ...(ps.role === undefined ? {} : { role: ps.role }),
    });
    const v = jsonAt(ex, ps.pointer);
    const n = typeof v === "number" ? v : Number(v);
    const okv =
      ps.op === ">="
        ? n >= ps.value
        : ps.op === "<="
          ? n <= ps.value
          : ps.op === ">"
            ? n > ps.value
            : ps.op === "<"
              ? n < ps.value
              : n === ps.value;
    if (!Number.isFinite(n) || !okv) {
      out.push(
        mkFailure(
          "bugs/race-lost-update",
          raceOp,
          `post-state:${ps.pointer}`,
          "post-state",
          `post-state ${ps.pointer}=${preview(v)} violates ${ps.op} ${ps.value}; ${summary}`,
          step,
          ex.status,
        ),
      );
    }
  }
  return out;
}

export function normalizeOpKey(s: string): string {
  const [m, ...rest] = s.trim().split(/\s+/);
  return `${(m ?? "").toUpperCase()} ${rest.join(" ")}`;
}

export const RULE_INFO = RULES;
