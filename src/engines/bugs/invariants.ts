/**
 * Developer-defined invariants (docs/03-engines/api-bug-hunter.md §1.4) loaded from the user's
 * own module files via dynamic import, plus the built-in concurrency invariants
 * (max-success, linearizable stock/counter/register/set, same-response).
 *
 * Invariant function contract (sync or async):
 *   per-exchange:   (ex: InvariantExchange) => boolean | string | void
 *   concurrency:    (burst: ConcurrencyContext) => boolean | string | void
 * `false` or a string (message) = violated; anything else = holds.
 */
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError } from "../../core/errors.js";
import {
  checkLinearizable,
  counterModel,
  describeHistory,
  type HistoryOp,
  type LinearizabilityResult,
  registerModel,
  type SequentialModel,
  setModel,
  stockModel,
  stockRwModel,
} from "./algorithms/linearizability.js";
import type { Exchange } from "./http.js";
import { getPointer } from "./json-schema.js";
import type { ConcurrencyTest, MixOp } from "./schema.js";

export interface InvariantExchange {
  operation: string;
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  requestBody?: string;
}

export interface ConcurrencyContext {
  operation: string;
  responses: InvariantExchange[];
  /** Mixed-operation tests: every exchange (main burst = tag -1, else index into `mix`) with timing. */
  mixed?: (InvariantExchange & { tag: number; tStart: number; tEnd: number })[];
  /** GET helper bound to the target (default role), e.g. to read post-state. */
  get(path: string): Promise<{ status: number; body: unknown }>;
}

export type InvariantResult = boolean | string | undefined | undefined | { ok: boolean; message?: string };
export type InvariantFn = (x: never) => InvariantResult | Promise<InvariantResult>;

export interface LoadedInvariant {
  name: string;
  fn: (x: unknown) => InvariantResult | Promise<InvariantResult>;
  operations?: string[];
}

export async function loadInvariant(
  ref:
    | string
    | {
        module: string;
        export?: string | undefined;
        operations?: string[] | undefined;
        name?: string | undefined;
      },
  cwd: string,
): Promise<LoadedInvariant> {
  const r = typeof ref === "string" ? { module: ref } : ref;
  let mod = r.module;
  let exp = "export" in r ? r.export : undefined;
  const hash = mod.lastIndexOf("#");
  if (hash > 1) {
    exp ??= mod.slice(hash + 1);
    mod = mod.slice(0, hash);
  }
  const file = isAbsolute(mod) ? mod : resolve(cwd, mod);
  let m: Record<string, unknown>;
  try {
    m = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(
      "SW_CONFIG_BUGS_INVARIANT",
      `Cannot load invariant module ${file}: ${(e as Error).message}`,
    );
  }
  const fn = exp ? m[exp] : (m.default ?? m.invariant);
  if (typeof fn !== "function") {
    throw new ConfigError(
      "SW_CONFIG_BUGS_INVARIANT",
      `Invariant module ${file} has no function export ${exp ?? "default/invariant"}`,
    );
  }
  const out: LoadedInvariant = {
    name: ("name" in r && r.name) || exp || mod,
    fn: fn as LoadedInvariant["fn"],
  };
  if ("operations" in r && r.operations) out.operations = r.operations;
  return out;
}

export function invariantMessage(r: InvariantResult): string | null {
  if (r === false) return "invariant returned false";
  if (typeof r === "string") return r;
  if (r && typeof r === "object" && "ok" in r && r.ok === false)
    return r.message ?? "invariant returned ok: false";
  return null;
}

export function toInvariantExchange(ex: Exchange): InvariantExchange {
  const out: InvariantExchange = {
    operation: ex.operation,
    method: ex.method,
    url: ex.url,
    status: ex.status,
    headers: ex.responseHeaders,
    body: ex.json ?? ex.responseBody,
  };
  if (ex.requestBody !== undefined) out.requestBody = ex.requestBody;
  return out;
}

export type BuiltinInvariant =
  | { kind: "max-success"; max: number }
  | { kind: "linearizable"; model: "stock" | "counter" | "register" | "set"; initial?: unknown; take: number }
  | { kind: "same-response"; pointer: string };

const ok2xx = (s: number): boolean => s >= 200 && s < 300;

/** Evaluates a built-in invariant on a burst. Returns a violation message or null. */
export function checkBuiltin(
  inv: BuiltinInvariant,
  exchanges: Exchange[],
): { message: string | null; linearizability?: LinearizabilityResult } {
  const done = exchanges.filter((e) => !e.blocked);
  if (inv.kind === "max-success") {
    const n = done.filter((e) => ok2xx(e.status)).length;
    return {
      message: n > inv.max ? `${n} of ${done.length} concurrent requests succeeded (max ${inv.max})` : null,
    };
  }
  if (inv.kind === "same-response") {
    const vals = new Set(
      done.filter((e) => ok2xx(e.status)).map((e) => JSON.stringify(getPointer(e.json, inv.pointer))),
    );
    return {
      message:
        vals.size > 1
          ? `${vals.size} distinct values at ${inv.pointer} for identical concurrent requests`
          : null,
    };
  }
  // linearizable
  if (inv.model === "stock") {
    const initial = typeof inv.initial === "number" ? inv.initial : 1;
    const history: HistoryOp<{ take: number }, boolean>[] = done.map((e) => ({
      input: { take: inv.take },
      output: e.error || e.status >= 500 ? undefined : ok2xx(e.status),
      call: e.tStart,
      ret: e.error ? Infinity : e.tEnd,
    }));
    const r = checkLinearizable(history, stockModel(initial));
    const succ = history.filter((h) => h.output === true).length;
    return {
      message:
        r.result === "violation"
          ? `Not linearizable against stock(${initial}): ${succ} of ${history.length} concurrent takes succeeded`
          : null,
      linearizability: r,
    };
  }
  if (inv.model === "counter") {
    const initial = typeof inv.initial === "number" ? inv.initial : 0;
    // Each 2xx response must contain the counter value after its increment.
    const history = done.map((e) => ({
      input: { op: "inc" as const },
      output: null,
      call: e.tStart,
      ret: e.error ? Infinity : e.tEnd,
    }));
    const values = done
      .filter((e) => ok2xx(e.status))
      .map((e) => (typeof e.json === "number" ? e.json : getPointer(e.json, "/value")));
    const r = checkLinearizable(history, counterModel(initial));
    const distinct = new Set(values.map((v) => JSON.stringify(v)));
    const lost =
      values.length > 1 && values.every((v) => typeof v === "number") && distinct.size < values.length;
    return {
      message: lost
        ? `Lost update: ${values.length} increments returned only ${distinct.size} distinct values`
        : null,
      linearizability: r,
    };
  }
  if (inv.model === "set") {
    const history = done.map((e) => ({
      input: { op: "add" as const, value: "x" },
      output: e.error ? undefined : e.status === 201,
      call: e.tStart,
      ret: e.error ? Infinity : e.tEnd,
    }));
    const r = checkLinearizable(
      history,
      setModel(Array.isArray(inv.initial) ? (inv.initial as string[]) : []),
    );
    return {
      message:
        r.result === "violation"
          ? "Not linearizable against set: the same element was created more than once"
          : null,
      linearizability: r,
    };
  }
  const history = done.map((e) => ({
    input: { op: "read" as const },
    output: e.error ? undefined : e.json,
    call: e.tStart,
    ret: e.error ? Infinity : e.tEnd,
  }));
  const r = checkLinearizable(history, registerModel<unknown>(inv.initial ?? null));
  return {
    message: r.result === "violation" ? "Not linearizable against register" : null,
    linearizability: r,
  };
}

// ------------------------------------------------------------------ mixed-operation histories

/** Statuses after which the effect of a request is unknown (it may or may not have happened). */
function ambiguous(e: Exchange): boolean {
  return (
    e.error !== undefined || e.status === 0 || e.status >= 500 || [401, 403, 408, 429].includes(e.status)
  );
}

function requestJson(e: Exchange): unknown {
  if (e.requestBody === undefined) return undefined;
  try {
    return JSON.parse(e.requestBody);
  } catch {
    return undefined;
  }
}

interface MixedInput {
  as: MixOp;
  /** Model input. */
  inner: unknown;
  /** Effect unknown: the op may also have had no effect. */
  unknown: boolean;
  /** Printable observation for the violation report. */
  shown: string;
}

/** Allows "no effect" for mutating ops whose outcome is unknown. */
function withUnknown<S>(m: SequentialModel<S, unknown, unknown>): SequentialModel<S, MixedInput, unknown> {
  return {
    name: m.name,
    init: () => m.init(),
    key: (s) => m.key(s),
    step(s, input, out) {
      const next = m.step(s, input.inner, out);
      if (
        input.unknown &&
        input.as !== "read" &&
        input.as !== "has" &&
        !next.some((x) => m.key(x) === m.key(s))
      )
        next.push(s);
      return next;
    },
  };
}

export const DEFAULT_PRIMARY: Record<string, MixOp> = {
  stock: "take",
  counter: "inc",
  register: "write",
  set: "add",
};

/**
 * Linearizability of a history that mixes operation types (e.g. concurrent POST /orders = take
 * with GET /products/{id} = read) against the sequential spec model. docs/04 §7.5.
 * `tags[k]` = -1 for the main burst request, else the index into `test.mix`.
 */
export function checkMixed(
  inv: Extract<BuiltinInvariant, { kind: "linearizable" }>,
  test: Pick<ConcurrencyTest, "as" | "pointer" | "mix">,
  exchanges: readonly Exchange[],
  tags: readonly number[],
): { message: string | null; linearizability?: LinearizabilityResult } {
  const primary: MixOp = test.as ?? (DEFAULT_PRIMARY[inv.model] as MixOp);
  const history: HistoryOp<MixedInput, unknown>[] = [];
  const counts: Record<string, number> = {};
  exchanges.forEach((e, k) => {
    if (e.blocked) return;
    const tag = tags[k] ?? -1;
    const spec = tag < 0 ? { as: primary, pointer: test.pointer, value: undefined } : test.mix[tag];
    if (!spec) return;
    const as = spec.as;
    const unk = ambiguous(e);
    const ok = !unk && ok2xx(e.status);
    const at = (root: unknown): unknown =>
      spec.pointer === undefined ? root : getPointer(root, spec.pointer);
    let inner: unknown;
    let output: unknown;
    let shown: string;
    if (as === "read") {
      if (inv.model === "set") return;
      output = ok ? at(e.json) : undefined;
      if (inv.model !== "register" && typeof output !== "number") output = undefined;
      inner = { op: "read" };
      shown = `read→${output === undefined ? `?(${e.status})` : JSON.stringify(output)}`;
    } else if (inv.model === "stock") {
      if (as !== "take") return;
      inner = { op: "take", n: inv.take };
      output = unk ? undefined : ok;
      shown = `take→${unk ? `?(${e.status || "error"})` : ok ? `ok(${e.status})` : `refused(${e.status})`}`;
    } else if (inv.model === "counter") {
      if (as !== "inc" && as !== "dec") return;
      if (!unk && !ok) return; // rejected: no effect, not part of the history
      inner = { op: as };
      output = null;
      shown = `${as}→${unk ? "?" : e.status}`;
    } else if (inv.model === "register") {
      if (as !== "write") return;
      if (!unk && !ok) return;
      inner = { op: "write", value: at(requestJson(e)) };
      output = null;
      shown = `write(${JSON.stringify((inner as { value: unknown }).value)})→${unk ? "?" : e.status}`;
    } else {
      if (as !== "add" && as !== "remove" && as !== "has") return;
      const value =
        "value" in spec && spec.value !== undefined ? spec.value : String(at(requestJson(e)) ?? "x");
      inner = { op: as, value };
      if (unk) output = undefined;
      else if (ok) output = true;
      else if (e.status === 404 || e.status === 409) output = false;
      else output = undefined;
      shown = `${as}(${value})→${output === undefined ? "?" : output}`;
    }
    counts[as] = (counts[as] ?? 0) + 1;
    history.push({
      input: { as, inner, unknown: unk || output === undefined, shown },
      output,
      call: e.tStart,
      ret: e.error ? Infinity : e.tEnd,
    });
  });
  if (history.length === 0) return { message: null };
  let model: SequentialModel<unknown, unknown, unknown>;
  if (inv.model === "stock")
    model = stockRwModel(typeof inv.initial === "number" ? inv.initial : undefined) as SequentialModel<
      unknown,
      unknown,
      unknown
    >;
  else if (inv.model === "counter")
    model = counterModel(typeof inv.initial === "number" ? inv.initial : 0) as SequentialModel<
      unknown,
      unknown,
      unknown
    >;
  else if (inv.model === "register")
    model = registerModel<unknown>(inv.initial ?? null) as SequentialModel<unknown, unknown, unknown>;
  else
    model = setModel(Array.isArray(inv.initial) ? (inv.initial as string[]) : []) as SequentialModel<
      unknown,
      unknown,
      unknown
    >;
  const r = checkLinearizable(history, withUnknown(model));
  const mixDesc = Object.entries(counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  const init =
    inv.initial === undefined
      ? inv.model === "stock"
        ? "unknown, from reads"
        : "default"
      : JSON.stringify(inv.initial);
  let message: string | null = null;
  if (r.result === "violation")
    message = `Not linearizable against ${inv.model}(initial ${init}) with mixed operations (${mixDesc}); no sequential order explains: ${describeHistory(history, (h) => h.input.shown)}`;
  return { message, linearizability: r };
}
