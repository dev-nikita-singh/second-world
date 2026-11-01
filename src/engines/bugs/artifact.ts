/**
 * Self-contained reproduction artifacts (docs/03-engines/api-bug-hunter.md §3 step 6).
 *
 * `embedContext` freezes everything a case references indirectly (concurrency test by index,
 * assertions, invariant modules, default role, contract) into `case.context`, so `sw replay`
 * works from the artifact alone. `hydrateForReplay` re-installs that context into a replay
 * session and FAILS SAFE: anything it cannot resolve yields a reason → classification
 * "inconclusive", never a false "does not reproduce".
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { BugCase, CaseContext } from "./cases.js";
import { matchesPattern } from "./contract.js";
import { ROLE_EXPIRED, ROLE_INVALID } from "./http.js";
import { type LoadedInvariant, loadInvariant } from "./invariants.js";
import type { ConcurrencyTest } from "./schema.js";
import type { Session } from "./session.js";

type InvRef = CaseContext["invariants"][number];

function absRef(ref: string | InvRef, cwd: string): InvRef {
  const r: InvRef = typeof ref === "string" ? { module: ref } : { ...ref };
  // Keep a "#export" suffix intact while absolutising the path part.
  const hash = r.module.lastIndexOf("#");
  const path = hash > 1 ? r.module.slice(0, hash) : r.module;
  const suffix = hash > 1 ? r.module.slice(hash) : "";
  r.module = (isAbsolute(path) ? path : resolve(cwd, path)) + suffix;
  return r;
}

/**
 * An artifact is data (it may come from someone else): importing a module runs its code, so replay
 * only loads invariant modules inside the current project (docs/11 threat model T6). Returns the
 * reason when `ref` points elsewhere.
 */
function outsideProject(ref: string | InvRef, cwd: string): string | undefined {
  const r = typeof ref === "string" ? { module: ref } : ref;
  const hash = r.module.lastIndexOf("#");
  const path = hash > 1 ? r.module.slice(0, hash) : r.module;
  const file = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const rel = relative(resolve(cwd), file);
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return undefined;
  return `invariant module ${file} is outside the project (${resolve(cwd)}); replay only loads project code`;
}

function isBuiltinInvariant(inv: unknown): inv is { kind: string } {
  return typeof inv === "object" && inv !== null && "kind" in inv;
}

/** Returns a copy of the case with an embedded replay context and explicit role names. */
export function embedContext(c: BugCase, s: Session): BugCase {
  const explicit = <T extends { request: BugCase["steps"][number]["request"] }>(st: T): T => {
    if (st.request.role !== undefined) return st;
    const role = st.request.secured ? (s.roles.default ?? null) : null;
    return { ...st, request: { ...st.request, role } };
  };
  const steps = c.steps.map((st0) => {
    const st = explicit(st0);
    return st.mix ? { ...st, mix: st.mix.map(explicit) } : st;
  });
  const roles = [
    ...new Set(
      steps
        .flatMap((st) => [st.request.role, ...(st.mix ?? []).map((m) => m.request.role)])
        .filter((r): r is string => typeof r === "string" && r !== ROLE_INVALID && r !== ROLE_EXPIRED),
    ),
  ];
  const ops = new Set(
    steps.flatMap((st) => [st.request.operation, ...(st.mix ?? []).map((m) => m.request.operation)]),
  );
  const opObjs = (s.contract?.operations ?? []).filter((o) => ops.has(o.key));
  const ctx: CaseContext = {
    version: 1,
    roles,
    assertions: s.input.assertions.filter((a) => opObjs.some((o) => matchesPattern(o, a.operation))),
    invariants: s.input.invariants
      .map((r) => absRef(r, s.cwd))
      .filter((r) => !r.operations || opObjs.some((o) => r.operations?.some((p) => matchesPattern(o, p)))),
  };
  if (s.contract) {
    const required =
      c.check.kind === "conformance" &&
      steps.some((st) => st.expect === "valid" || st.expect === "invalid" || st.expect === "any");
    ctx.contract = { source: s.contract.source, hash: s.contract.hash, required };
  }
  let check = c.check;
  if (c.check.kind === "concurrency") {
    const test = s.input.concurrency[c.check.test];
    if (test) {
      const spec: ConcurrencyTest = structuredClone(test);
      if (spec.invariant !== undefined && !isBuiltinInvariant(spec.invariant))
        spec.invariant = absRef(spec.invariant, s.cwd);
      ctx.concurrency = spec;
      check = { kind: "concurrency", test: 0 };
    }
  }
  return { ...c, steps, check, context: ctx };
}

export type HydrateResult = { ok: true; case: BugCase } | { ok: false; reason: string };

/** Installs the artifact's context into a replay session (mutates `s.env`). */
export async function hydrateForReplay(c: BugCase, s: Session): Promise<HydrateResult> {
  const ctx = c.context;
  if (!ctx) {
    // Legacy artifact: only safe when nothing is referenced by index.
    if (c.check.kind === "concurrency" && !s.env.concurrency[c.check.test]) {
      return {
        ok: false,
        reason: `artifact references concurrency test #${c.check.test}, which is not embedded and not in the current config`,
      };
    }
    return { ok: true, case: c };
  }
  if (ctx.contract?.required && !s.contract) {
    return {
      ok: false,
      reason: `this finding is checked against the contract (${ctx.contract.source}); pass --openapi / bugs.contract`,
    };
  }
  const configured = Object.keys(s.input.auth.roles);
  const missingRoles = ctx.roles.filter((r) => !configured.includes(r));
  if (missingRoles.length > 0) {
    return { ok: false, reason: `test account(s) ${missingRoles.join(", ")} not configured (auth.roles)` };
  }
  const invariants: LoadedInvariant[] = [];
  for (const ref of ctx.invariants) {
    const outside = outsideProject(ref, s.cwd);
    if (outside) return { ok: false, reason: outside };
    try {
      invariants.push(await loadInvariant(ref, s.cwd));
    } catch (e) {
      return { ok: false, reason: `invariant cannot be loaded: ${(e as Error).message}` };
    }
  }
  s.env.assertions = ctx.assertions;
  s.env.invariants = invariants;
  if (c.check.kind === "concurrency") {
    if (!ctx.concurrency) return { ok: false, reason: "concurrency check without an embedded test spec" };
    s.env.concurrency = [ctx.concurrency];
    s.env.concurrencyFns = new Map();
    const inv = ctx.concurrency.invariant;
    if (inv !== undefined && !isBuiltinInvariant(inv)) {
      const outside = outsideProject(inv as string | InvRef, s.cwd);
      if (outside) return { ok: false, reason: outside };
      try {
        s.env.concurrencyFns.set(0, await loadInvariant(inv as string | InvRef, s.cwd));
      } catch (e) {
        return { ok: false, reason: `concurrency invariant cannot be loaded: ${(e as Error).message}` };
      }
    }
    return { ok: true, case: { ...c, check: { kind: "concurrency", test: 0 } } };
  }
  return { ok: true, case: c };
}
