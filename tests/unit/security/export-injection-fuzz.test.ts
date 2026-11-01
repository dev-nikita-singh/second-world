/**
 * Exported agent tests (src/engines/agent/export.ts) must never execute injected code (threat model
 * T5: hostile OpenAPI operation names / paths, hostile response-derived values).
 *
 * Property: for a scenario and meta full of hostile strings (U+2028/2029, backticks, `${}`, `*\/`,
 * quotes, backslashes, newlines, `</script>`, lone surrogates…), the generated Vitest file and the
 * sw.config snippet parse WITHOUT syntax errors and have exactly the same syntax tree shape as the
 * output for the same scenario with every string replaced by a harmless one. Any string that escaped
 * its literal (or a comment) would add or change nodes.
 */
import fc from "fast-check";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { type ExportMeta, suggestedTest } from "../../../src/engines/agent/export.js";
import type { Scenario } from "../../../src/engines/agent/scenario.js";

const NUM_RUNS = Number(process.env.SW_FUZZ_RUNS ?? 300);
const SEED = process.env.SW_FUZZ_SEED ? Number(process.env.SW_FUZZ_SEED) : 0x5ec_0e0e;

const PAYLOADS = [
  " process.exit(13)//",
  " process.exit(13)",
  "`; process.exit(13); `",
  "$" + "{process.exit(13)}", // a template-literal hole, spelled so it is not one here
  "*/ process.exit(13); /*",
  '"); process.exit(13); ("',
  "'); process.exit(13); ('",
  "\nprocess.exit(13)\n",
  "\r\nprocess.exit(13)//",
  "\\",
  "\\u2028",
  "</script><script>alert(1)</script>",
  "-->",
  "#!/bin/sh",
  "\ud800",
  "{{$nonce}}",
  "__proto__",
  "constructor",
];

const hostile = fc.oneof(
  fc.constantFrom(...PAYLOADS),
  fc.string({ maxLength: 12 }),
  fc.string({ unit: "binary", maxLength: 8 }),
  fc.tuple(fc.constantFrom(...PAYLOADS), fc.constantFrom(...PAYLOADS)).map(([a, b]) => a + b),
);
const dict = fc.dictionary(hostile, hostile, { maxKeys: 3 });
const jsonish = fc.oneof(hostile, dict, fc.array(hostile, { maxLength: 3 }), fc.integer(), fc.constant(null));

const step = fc.record(
  {
    operation: hostile,
    pathParams: dict,
    query: dict,
    headers: dict,
    body: jsonish,
    extract: dict,
  },
  { requiredKeys: ["operation"] },
);

const scenarioAndMeta = fc
  .tuple(
    fc.array(step, { maxLength: 2 }),
    fc.array(step, { minLength: 1, maxLength: 3 }),
    hostile,
    hostile,
    fc.array(hostile, { minLength: 1, maxLength: 3 }),
    fc.record({ fingerprint: hostile, ruleId: hostile, operation: hostile, target: hostile }),
    fc.array(fc.record({ method: hostile, path: hostile }), { minLength: 5, maxLength: 5 }),
    hostile,
    fc.boolean(),
  )
  .map(([setup, steps, title, hypothesis, roleNames, m, requests, headerName, parallel]) => {
    const last = steps.length - 1;
    const s = {
      title,
      hypothesis,
      setup,
      steps,
      ...(parallel ? { parallel: { copies: 3, step: last } } : {}),
      assertions: [
        { kind: "status", step: 0, oneOf: [200, 201] },
        { kind: "status-class", step: 0, class: "not-5xx" },
        { kind: "no-5xx" },
        { kind: "same-json", steps: [0, last], pointer: `/${title}` },
        {
          kind: "json",
          step: last,
          pointer: `/${hypothesis}`,
          equals: { [title]: hypothesis },
          exists: true,
          type: "string",
        },
        { kind: "max-duration", step: 0, ms: 1000 },
        { kind: "schema-valid", step: 0 },
        ...(parallel
          ? [
              { kind: "copies-agree", step: last, pointer: `/${title}` },
              { kind: "max-success", step: last, max: 1 },
            ]
          : []),
      ],
      expectedClassification: "defect",
    } as unknown as Scenario;
    const roles = [...setup, ...steps].map((_, i) =>
      i % 2 === 0 ? (roleNames[i % roleNames.length] as string) : null,
    );
    const meta: ExportMeta = {
      ...m,
      roles,
      requests: requests.slice(0, setup.length + steps.length),
      credentials: Object.fromEntries(
        roleNames.map((r, i) => [
          r,
          i % 3 === 0
            ? { type: "bearer", token: "x" }
            : i % 3 === 1
              ? { type: "basic", username: "u", password: "p" }
              : { type: "header", name: headerName || "x-key", value: "v" },
        ]),
      ) as ExportMeta["credentials"],
      shapes: {
        [setup.length]: {
          required: [title, hypothesis],
          types: { [title]: "string", [hypothesis]: "integer" },
        },
      },
    };
    return { s, meta };
  });

/** Replaces every string (keys and values) by a unique harmless one; enum-like fields are kept. */
function defang<T>(v: T, table: Map<string, string>): T {
  const sub = (s: string): string => {
    let r = table.get(s);
    if (r === undefined) {
      r = `s${table.size}`;
      table.set(s, r);
    }
    return r;
  };
  const KEEP = new Set(["kind", "class", "type", "expectedClassification"]);
  const walk = (x: unknown, key?: string): unknown => {
    if (typeof x === "string") return key !== undefined && KEEP.has(key) ? x : sub(x);
    if (Array.isArray(x)) return x.map((e) => walk(e));
    if (x !== null && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, e] of Object.entries(x)) {
        const nk = /^\d+$/.test(k) || KEEP.has(k) || isStructuralKey(k) ? k : sub(k);
        Object.defineProperty(out, nk, {
          value: walk(e, k),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return x;
  };
  return walk(v) as T;
}

const STRUCTURAL = new Set([
  "title",
  "hypothesis",
  "setup",
  "steps",
  "parallel",
  "copies",
  "step",
  "assertions",
  "oneOf",
  "pointer",
  "equals",
  "exists",
  "ms",
  "max",
  "operation",
  "pathParams",
  "query",
  "headers",
  "body",
  "extract",
  "fingerprint",
  "ruleId",
  "target",
  "roles",
  "requests",
  "method",
  "path",
  "credentials",
  "shapes",
  "required",
  "types",
  "token",
  "username",
  "password",
  "name",
  "value",
]);
function isStructuralKey(k: string): boolean {
  return STRUCTURAL.has(k);
}

/** Node kinds in document order; literals reduced to their kind. */
function shape(code: string): { kinds: string; diagnostics: number } {
  const sf = ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const kinds: string[] = [];
  const visit = (n: ts.Node): void => {
    kinds.push(ts.SyntaxKind[n.kind] as string);
    n.forEachChild(visit);
  };
  visit(sf);
  const diags = (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length;
  return { kinds: kinds.join(" "), diagnostics: diags };
}

describe("exported agent tests: no code injection (fast-check)", () => {
  it("hostile strings never change the syntax tree of the Vitest file or the config snippet", () => {
    fc.assert(
      fc.property(scenarioAndMeta, ({ s, meta }) => {
        // The defanged twin of the same scenario: every user/target string replaced, shared mapping.
        const table = new Map<string, string>();
        const safeS = defang(s, table);
        const safeMeta = defang(meta, table);
        // Keys that are role names must map like the role values do (auth map lookups).
        const out = suggestedTest(s, meta);
        const ref = suggestedTest(safeS, safeMeta);
        const a = shape(out.vitest);
        const b = shape(ref.vitest);
        expect(a.diagnostics).toBe(0);
        expect(a.kinds).toBe(b.kinds);
        const ca = shape(`const c = {\n${out.config}};\n`);
        const cb = shape(`const c = {\n${ref.config}};\n`);
        expect(ca.diagnostics).toBe(0);
        expect(ca.kinds).toBe(cb.kinds);
        // The filename is a plain basename.
        expect(out.filename).toMatch(/^agent-[a-z0-9-]+-[a-z0-9-]+\.test\.ts$/);
        return true;
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it("the generated file runs no injected code when evaluated up to the test body (smoke)", () => {
    // A concrete worst case: every payload at once in the comment line and every literal.
    const p = PAYLOADS.join("");
    const s = {
      title: p,
      hypothesis: p,
      setup: [],
      steps: [{ operation: p, headers: { [p]: p }, body: { [p]: [p] } }],
      assertions: [{ kind: "json", step: 0, pointer: `/${p}`, equals: p }],
      expectedClassification: "defect",
    } as unknown as Scenario;
    const out = suggestedTest(s, {
      fingerprint: p,
      ruleId: p,
      operation: p,
      target: p,
      roles: [null],
      requests: [{ method: p, path: p }],
      credentials: {},
    });
    const js = ts.transpileModule(out.vitest, {
      compilerOptions: { module: ts.ModuleKind.ESNext },
    }).outputText;
    // Only the declarations before describe(): they must evaluate without calling process.exit.
    const head = js.slice(js.indexOf("const DEFAULT_TARGET"), js.indexOf("const TARGET"));
    const exit = process.exit;
    let called = false;
    process.exit = (() => {
      called = true;
    }) as typeof process.exit;
    try {
      new Function(head)();
    } finally {
      process.exit = exit;
    }
    expect(called).toBe(false);
  });
});
