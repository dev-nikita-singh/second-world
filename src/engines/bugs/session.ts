/**
 * Session setup shared by the hunt and `sw replay`: safety checks, mutation gate, budget lease,
 * contract, roles, HTTP client, hooks, invariants. docs/03-engines/api-bug-hunter.md §5,
 * docs/11-safety-security-privacy.md §2.
 */
import { SafetyError } from "../../core/errors.js";
import type { Limitation } from "../../core/evidence/schemas.js";
import { createRng } from "../../core/rng.js";
import type { BudgetLease, EngineContext } from "../../core/types.js";
import type { EvalEnv } from "./cases.js";
import { type Contract, loadContract, type Operation, targetWithBasePath } from "./contract.js";
import { Dictionary } from "./dictionary.js";
import type { GenContext } from "./generate.js";
import { createHookRunner, type HookRunner } from "./hooks.js";
import { BugsHttp } from "./http.js";
import { type LoadedInvariant, loadInvariant } from "./invariants.js";
import type { BugsInput } from "./schema.js";

export interface Session {
  input: BugsInput;
  ctx: EngineContext;
  cwd: string;
  seed: number;
  contract?: Contract;
  http: BugsHttp;
  hooks: HookRunner;
  env: EvalEnv;
  gen?: GenContext;
  dict: Dictionary;
  lease: BudgetLease;
  mutationsAllowed: boolean;
  limitations: Limitation[];
  roles: GenContext["roles"];
  close(): Promise<void>;
}

async function decideMutations(
  input: BugsInput,
  ctx: EngineContext,
  limitations: Limitation[],
): Promise<boolean> {
  if (input.allowMutations === true) {
    ctx.safety.audit({
      action: "bugs.mutations.allowed",
      target: input.target,
      detail: { source: "allowMutations" },
    });
    return true;
  }
  if (input.allowMutations === false) {
    limitations.push({
      code: "BUGS_MUTATIONS_BLOCKED",
      message: "State-changing requests (POST/PUT/PATCH/DELETE) are disabled (allowMutations: false)",
      impact: "reduces-confidence",
    });
    return false;
  }
  const cfg = (ctx.safety as { config?: { allowMutations?: boolean; environment?: string } }).config;
  if (cfg?.allowMutations === true || cfg?.environment === "isolated" || cfg?.environment === "staging") {
    ctx.safety.audit({
      action: "bugs.mutations.allowed",
      target: input.target,
      detail: { source: cfg.allowMutations ? "safety.allowMutations" : `environment:${cfg.environment}` },
    });
    return true;
  }
  try {
    await ctx.safety.requireApproval(
      "mutating-requests",
      `API Bug Hunter POST/PUT/PATCH/DELETE to ${input.target}`,
    );
    return true;
  } catch (e) {
    if (!(e instanceof SafetyError)) throw e;
    limitations.push({
      code: "BUGS_MUTATIONS_BLOCKED",
      message: `State-changing requests were not sent: ${e.message}. Set allowMutations: true (test environments only) or approve with --yes`,
      impact: "reduces-confidence",
    });
    return false;
  }
}

function roleSetup(input: BugsInput): GenContext["roles"] {
  const names = Object.keys(input.auth.roles);
  const privileged = names.filter(
    (n) =>
      input.auth.roles[n]?.privileged === true ||
      (input.auth.roles[n]?.privileged === undefined && /admin|root|super/i.test(n)),
  );
  const unprivileged = names.filter((n) => !privileged.includes(n));
  const roles: GenContext["roles"] = { privileged, unprivileged };
  const def = input.auth.default ?? unprivileged[0] ?? names[0];
  if (def !== undefined) roles.default = def;
  const owner = input.auth.owner ?? unprivileged[0];
  const attacker = input.auth.attacker ?? unprivileged.find((n) => n !== owner);
  if (owner !== undefined) roles.owner = owner;
  if (attacker !== undefined) roles.attacker = attacker;
  return roles;
}

export async function openSession(
  input: BugsInput,
  ctx: EngineContext,
  opts: { forReplay?: boolean; extraInvariants?: readonly LoadedInvariant[] } = {},
): Promise<Session> {
  const cwd = input.cwd ?? process.cwd();
  const target = new URL(input.target);
  const d = ctx.safety.checkTarget(target);
  if (!d.allowed) {
    const code = (d.code.startsWith("SW_SAFETY_") ? d.code : `SW_SAFETY_${d.code}`) as `SW_SAFETY_${string}`;
    ctx.safety.audit({ action: "bugs.blocked", target: target.origin, detail: { code: d.code } });
    throw new SafetyError(code, d.reason, { hint: d.hint, details: { target: target.origin } });
  }
  const limitations: Limitation[] = [];
  const contract = input.openapi !== undefined ? await loadContract(input.openapi, cwd) : undefined;
  if (contract?.version === "2.0") {
    limitations.push({
      code: "BUGS_SWAGGER2",
      message: "Swagger 2.0 contract converted best-effort (formData and collectionFormat are not exercised)",
      impact: "informational",
    });
  }
  const needsMutations =
    !contract || contract.operations.some((o) => o.mutating) || input.concurrency.length > 0;
  const mutationsAllowed = needsMutations ? await decideMutations(input, ctx, limitations) : false;
  const budget: { maxRequests: number; maxRps?: number; maxConcurrency?: number; maxDurationMs?: number } = {
    maxRequests: input.budget.maxRequests,
  };
  if (input.budget.maxRps !== undefined) budget.maxRps = input.budget.maxRps;
  if (input.budget.maxConcurrency !== undefined) budget.maxConcurrency = input.budget.maxConcurrency;
  if (input.budget.maxDuration !== undefined) budget.maxDurationMs = input.budget.maxDuration;
  const lease = ctx.safety.reserve(budget);
  const roles = roleSetup(input);
  const http = new BugsHttp(ctx, {
    // OpenAPI servers "/api" (or Swagger basePath) applies when the target has no path of its own.
    target: targetWithBasePath(input.target, contract),
    timeoutMs: input.timeout,
    headers: input.headers,
    roles: input.auth.roles,
    ...(roles.default === undefined ? {} : { defaultRole: roles.default }),
    invalidToken: input.auth.invalidToken,
    ...(input.auth.expiredToken === undefined ? {} : { expiredToken: input.auth.expiredToken }),
    mutationsAllowed,
    lease,
  });
  const hooks = createHookRunner(ctx, input.hooks, {
    cwd,
    target: input.target,
    timeoutMs: input.timeout * 2,
  });
  const invariants: LoadedInvariant[] = [];
  for (const ref of input.invariants) invariants.push(await loadInvariant(ref, cwd));
  // Plugin assertions (docs/10 §2), already bound to their plugin by the world.
  invariants.push(...(opts.extraInvariants ?? []));
  const concurrencyFns = new Map<number, LoadedInvariant>();
  for (const [i, t] of input.concurrency.entries()) {
    const inv = t.invariant;
    if (inv !== undefined && !(typeof inv === "object" && "kind" in inv))
      concurrencyFns.set(i, await loadInvariant(inv, cwd));
  }
  const dict = new Dictionary(input.values);
  const opsByKey = new Map<string, Operation>((contract?.operations ?? []).map((o) => [o.key, o]));
  const env: EvalEnv = {
    http,
    opsByKey,
    assertions: input.assertions,
    invariants,
    concurrency: input.concurrency,
    concurrencyFns,
    dict,
  };
  if (contract) env.contract = contract;
  const seed = input.seed ?? ctx.rng.seed;
  const s: Session = {
    input,
    ctx,
    cwd,
    seed,
    http,
    hooks,
    env,
    dict,
    lease,
    mutationsAllowed,
    limitations,
    roles,
    close: async () => {
      await Promise.allSettled([http.close(), hooks.close()]);
      lease.release();
    },
  };
  if (contract) {
    s.contract = contract;
    s.gen = { contract, dict, rng: createRng(seed), seed, input, roles };
  }
  void opts;
  return s;
}
