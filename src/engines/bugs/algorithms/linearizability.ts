/**
 * Bounded Wing–Gong linearizability checker with memoisation (as in Porcupine/Knossos).
 * docs/04-data-structures-and-algorithms.md §7.5.
 *
 * A history is linearizable if some total order of its operations that respects real-time
 * precedence (a returned before b was invoked ⇒ a before b) is accepted by the sequential
 * model. Iterative DFS over (linearized-set, model-state) with a visited set; capped by
 * `maxSteps` (→ "unknown"). Histories are meant to be small (≤ ~64 ops per burst).
 */

export interface HistoryOp<I, O> {
  input: I;
  /** Observed output. `undefined` = unknown (timeout/transport error): any outcome accepted. */
  output: O | undefined;
  /** Invocation time (ms). */
  call: number;
  /** Response time (ms). Use Infinity for operations that never returned. */
  ret: number;
}

export interface SequentialModel<S, I, O> {
  name: string;
  init(): S;
  /** Possible next states when `input` is applied to `state` and returned `output` (empty = impossible). */
  step(state: S, input: I, output: O | undefined): S[];
  key(state: S): string;
}

export interface LinearizabilityResult {
  result: "ok" | "violation" | "unknown";
  /** A witness order (indices into the history) when ok. */
  order?: number[];
  steps: number;
}

export function checkLinearizable<S, I, O>(
  history: readonly HistoryOp<I, O>[],
  model: SequentialModel<S, I, O>,
  opts: { maxSteps?: number } = {},
): LinearizabilityResult {
  const maxSteps = opts.maxSteps ?? 200_000;
  const n = history.length;
  if (n === 0) return { result: "ok", order: [], steps: 0 };
  const full = (1n << BigInt(n)) - 1n;
  interface Frame {
    mask: bigint;
    state: S;
    order: number[];
  }
  const stack: Frame[] = [{ mask: 0n, state: model.init(), order: [] }];
  const seen = new Set<string>();
  let steps = 0;
  while (stack.length > 0) {
    const f = stack.pop() as Frame;
    if (f.mask === full) return { result: "ok", order: f.order, steps };
    if (++steps > maxSteps) return { result: "unknown", steps };
    // Minimal ops: not linearized and no other pending op returned strictly before its call.
    let minRet = Infinity;
    for (let i = 0; i < n; i++) {
      if ((f.mask >> BigInt(i)) & 1n) continue;
      const r = (history[i] as HistoryOp<I, O>).ret;
      if (r < minRet) minRet = r;
    }
    for (let i = n - 1; i >= 0; i--) {
      if ((f.mask >> BigInt(i)) & 1n) continue;
      const op = history[i] as HistoryOp<I, O>;
      if (op.call > minRet) continue;
      const nextMask = f.mask | (1n << BigInt(i));
      for (const s of model.step(f.state, op.input, op.output)) {
        const k = `${nextMask.toString(36)}|${model.key(s)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push({ mask: nextMask, state: s, order: [...f.order, i] });
      }
    }
  }
  return { result: "violation", steps };
}

// ------------------------------------------------------------------ built-in models

/** Stock / semaphore: `take n` succeeds iff stock ≥ n (then decrements); fails iff stock < n. */
export function stockModel(initial: number): SequentialModel<number, { take: number }, boolean> {
  return {
    name: "stock",
    init: () => initial,
    step(s, input, ok) {
      const can = s >= input.take;
      const out: number[] = [];
      if ((ok === true || ok === undefined) && can) out.push(s - input.take);
      if ((ok === false || ok === undefined) && !can) out.push(s);
      if (ok === undefined && can) out.push(s); // an unknown op may also have had no effect
      return out;
    },
    key: (s) => String(s),
  };
}

export type StockOp = { op: "take"; n: number } | { op: "read" };

/**
 * Stock with mixed operations: `take n` (output = succeeded?) and `read` (output = observed
 * stock). `initial` undefined = unknown: the state stays unconstrained (null) until the first
 * linearized read fixes it, so a leading "before" read can supply the initial value.
 * Output `undefined` (timeout / 5xx / ambiguous status) accepts every outcome.
 */
export function stockRwModel(initial?: number): SequentialModel<number | null, StockOp, boolean | number> {
  return {
    name: "stock-rw",
    init: () => (typeof initial === "number" ? initial : null),
    step(s, input, out) {
      if (input.op === "read") {
        if (out === undefined || typeof out !== "number") return [s];
        if (s === null) return [out];
        return out === s ? [s] : [];
      }
      if (s === null) {
        // Unknown stock: a take is consistent either way; the level stays unknown.
        return [null];
      }
      const can = s >= input.n;
      const next: (number | null)[] = [];
      if ((out === true || out === undefined) && can) next.push(s - input.n);
      if ((out === false || out === undefined) && !can) next.push(s);
      if (out === undefined && can) next.push(s);
      return next;
    },
    key: (s) => (s === null ? "?" : String(s)),
  };
}

/** Compact text of a history in invocation order, e.g. "take→ok [0,5] · read→0 [6,7]". */
export function describeHistory<I, O>(
  history: readonly HistoryOp<I, O>[],
  label: (op: HistoryOp<I, O>) => string,
  max = 16,
): string {
  const idx = history
    .map((_, i) => i)
    .sort((a, b) => (history[a] as HistoryOp<I, O>).call - (history[b] as HistoryOp<I, O>).call);
  const t0 = history.reduce((m, h) => Math.min(m, h.call), Infinity);
  const parts = idx.slice(0, max).map((i) => {
    const h = history[i] as HistoryOp<I, O>;
    const r = Number.isFinite(h.ret) ? (h.ret - t0).toFixed(1) : "∞";
    return `${label(h)} [${(h.call - t0).toFixed(1)},${r}]`;
  });
  if (idx.length > max) parts.push(`… +${idx.length - max}`);
  return parts.join(" · ");
}

export type CounterInput = { op: "inc"; by?: number } | { op: "dec"; by?: number } | { op: "read" };

/** Counter: inc/dec return nothing meaningful (output ignored), read returns the value. */
export function counterModel(initial = 0): SequentialModel<number, CounterInput, number | null> {
  return {
    name: "counter",
    init: () => initial,
    step(s, input, out) {
      if (input.op === "inc") return [s + (input.by ?? 1)];
      if (input.op === "dec") return [s - (input.by ?? 1)];
      if (out === undefined || out === s) return [s];
      return [];
    },
    key: (s) => String(s),
  };
}

export type RegisterInput<V> = { op: "write"; value: V } | { op: "read" };

/** Register: write v; read returns the last written value. Values compared by JSON. */
export function registerModel<V>(initial: V): SequentialModel<V, RegisterInput<V>, V | null> {
  return {
    name: "register",
    init: () => initial,
    step(s, input, out) {
      if (input.op === "write") return [input.value];
      if (out === undefined || JSON.stringify(out) === JSON.stringify(s)) return [s];
      return [];
    },
    key: (s) => JSON.stringify(s) ?? "undefined",
  };
}

export type SetInput =
  | { op: "add"; value: string }
  | { op: "remove"; value: string }
  | { op: "has"; value: string };

/** Set: add/remove return whether the set changed; has returns membership. */
export function setModel(initial: readonly string[] = []): SequentialModel<string[], SetInput, boolean> {
  return {
    name: "set",
    init: () => [...initial].sort(),
    step(s, input, out) {
      const has = s.includes(input.value);
      if (input.op === "has") return out === undefined || out === has ? [s] : [];
      if (input.op === "add") {
        const next = has ? s : [...s, input.value].sort();
        return out === undefined || out === !has ? [next] : [];
      }
      const next = has ? s.filter((x) => x !== input.value) : s;
      return out === undefined || out === has ? [next] : [];
    },
    key: (s) => s.join("\u0000"),
  };
}
