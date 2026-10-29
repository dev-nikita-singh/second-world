/**
 * Logic-less `{{var}}` templates compiled once into closures (no eval).
 * See docs/08-configuration.md §3 "Templates" and docs/05-optimization.md §2 item 1.
 *
 * Built-ins: `uuid`, `ulid`, `rand a b`, `seq`, `now`, `data.<col>`, extracted variables.
 * All randomness comes from the injected seeded RNG, so runs are reproducible.
 */
import type { Rng } from "../../core/types.js";

export interface TemplateScope {
  rng: Rng;
  /** Variables extracted by previous steps of the current iteration. */
  vars: Record<string, string>;
  /** Current data-feeder row (if any). */
  row?: Record<string, string | number | boolean> | undefined;
  /** Monotonic counter shared by the run (`{{seq}}`). */
  nextSeq(): number;
  /** Wall-clock epoch ms (`{{now}}`). */
  epochMs(): number;
}

export type CompiledTemplate = ((scope: TemplateScope) => string) & {
  /** True when the template has no `{{ }}` expressions (value can be precomputed). */
  readonly constant: boolean;
  /** Names of variables referenced (extracted vars only). */
  readonly vars: readonly string[];
};

type Part = (scope: TemplateScope) => string;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const HEX = "0123456789abcdef";

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly template: string,
  ) {
    super(`${message} in template ${JSON.stringify(template)}`);
    this.name = "TemplateError";
  }
}

function uuidFrom(rng: Rng): string {
  let s = "";
  for (let i = 0; i < 32; i++) {
    let n = rng.int(0, 15);
    if (i === 12) n = 4; // version
    if (i === 16) n = (n & 0x3) | 0x8; // variant
    s += HEX[n];
    if (i === 7 || i === 11 || i === 15 || i === 19) s += "-";
  }
  return s;
}

function ulidFrom(rng: Rng, epochMs: number): string {
  let t = Math.max(0, Math.floor(epochMs));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[rng.int(0, 31)];
  return time + rand;
}

function compileExpr(expr: string, source: string, varNames: Set<string>): Part {
  const tokens = expr.trim().split(/\s+/);
  const head = tokens[0] ?? "";
  if (head === "") throw new TemplateError("empty expression {{}}", source);
  switch (head) {
    case "uuid":
      return (s) => uuidFrom(s.rng);
    case "ulid":
      return (s) => ulidFrom(s.rng, s.epochMs());
    case "seq":
      return (s) => String(s.nextSeq());
    case "now":
      return (s) => String(Math.floor(s.epochMs()));
    case "rand": {
      const a = Number(tokens[1]);
      const b = Number(tokens[2]);
      if (tokens.length !== 3 || !Number.isInteger(a) || !Number.isInteger(b) || a > b) {
        throw new TemplateError(`"rand" needs two integers a <= b (got "${expr.trim()}")`, source);
      }
      return (s) => String(s.rng.int(a, b));
    }
    default:
      break;
  }
  if (tokens.length !== 1) throw new TemplateError(`unknown helper "${head}"`, source);
  if (head.startsWith("data.")) {
    const col = head.slice(5);
    if (col === "") throw new TemplateError("data.<column> needs a column name", source);
    return (s) => {
      const v = s.row?.[col];
      return v === undefined ? "" : String(v);
    };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(head))
    throw new TemplateError(`invalid variable name "${head}"`, source);
  varNames.add(head);
  return (s) => s.vars[head] ?? "";
}

/**
 * Compiles a template string. `escaper` is applied to every substituted value
 * (e.g. JSON string escaping or URI encoding), never to literal text.
 */
export function compileTemplate(source: string, escaper?: (v: string) => string): CompiledTemplate {
  const parts: Part[] = [];
  const varNames = new Set<string>();
  let i = 0;
  let hasExpr = false;
  while (i < source.length) {
    const open = source.indexOf("{{", i);
    if (open < 0) {
      const lit = source.slice(i);
      parts.push(() => lit);
      break;
    }
    if (open > i) {
      const lit = source.slice(i, open);
      parts.push(() => lit);
    }
    const close = source.indexOf("}}", open + 2);
    if (close < 0) throw new TemplateError("unterminated {{", source);
    const part = compileExpr(source.slice(open + 2, close), source, varNames);
    parts.push(escaper ? (s) => escaper(part(s)) : part);
    hasExpr = true;
    i = close + 2;
  }
  let fn: (scope: TemplateScope) => string;
  if (!hasExpr) {
    const constant = source;
    fn = () => constant;
  } else if (parts.length === 1) {
    fn = parts[0] as Part;
  } else {
    fn = (scope) => {
      let out = "";
      for (let k = 0; k < parts.length; k++) out += (parts[k] as Part)(scope);
      return out;
    };
  }
  return Object.assign(fn, { constant: !hasExpr, vars: [...varNames] });
}

/** Escapes a value for insertion inside a JSON string literal. */
export function jsonStringEscape(v: string): string {
  return JSON.stringify(v).slice(1, -1);
}

/**
 * Compiles a JSON body: the object is serialised once and templates inside string values are
 * substituted with JSON escaping. Constant bodies are pre-serialised to a Buffer.
 */
export function compileJsonBody(json: unknown): { constant: Buffer | null; render: CompiledTemplate } {
  const text = JSON.stringify(json) ?? "null";
  const render = compileTemplate(text, jsonStringEscape);
  return { constant: render.constant ? Buffer.from(text) : null, render };
}
