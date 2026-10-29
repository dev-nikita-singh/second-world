import { describe, expect, it } from "vitest";
import { createRng } from "../../../src/core/rng.js";
import {
  compileJsonBody,
  compileTemplate,
  TemplateError,
  type TemplateScope,
} from "../../../src/engines/performance/templates.js";

function scope(over: Partial<TemplateScope> = {}): TemplateScope {
  let seq = 0;
  return {
    rng: createRng(7),
    vars: {},
    nextSeq: () => ++seq,
    epochMs: () => 1_700_000_000_000,
    ...over,
  };
}

describe("templates", () => {
  it("constant templates are flagged and returned verbatim", () => {
    const t = compileTemplate("/api/products");
    expect(t.constant).toBe(true);
    expect(t(scope())).toBe("/api/products");
  });

  it("substitutes vars, data, seq, now and rand", () => {
    const t = compileTemplate("/u/{{id}}/{{data.sku}}/{{seq}}/{{seq}}/{{now}}/{{rand 3 3}}");
    expect(t.constant).toBe(false);
    expect(t.vars).toEqual(["id"]);
    expect(t(scope({ vars: { id: "42" }, row: { sku: "A1" } }))).toBe("/u/42/A1/1/2/1700000000000/3");
  });

  it("rand stays in range and is reproducible with the same seed", () => {
    const t = compileTemplate("{{rand 1 20}}");
    const a = scope();
    const b = scope();
    for (let i = 0; i < 200; i++) {
      const x = Number(t(a));
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(20);
      expect(t(b)).toBe(String(x));
    }
  });

  it("uuid and ulid have the right shape", () => {
    const s = scope();
    expect(compileTemplate("{{uuid}}")(s)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(compileTemplate("{{ulid}}")(s)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("applies the escaper only to substituted values", () => {
    const t = compileTemplate("/q?x={{v}}&y=a b", encodeURIComponent);
    expect(t(scope({ vars: { v: "a&b c" } }))).toBe("/q?x=a%26b%20c&y=a b");
  });

  it("rejects malformed templates", () => {
    expect(() => compileTemplate("{{")).toThrow(TemplateError);
    expect(() => compileTemplate("{{}}")).toThrow(TemplateError);
    expect(() => compileTemplate("{{rand 5 1}}")).toThrow(TemplateError);
    expect(() => compileTemplate("{{lookup x}}")).toThrow(TemplateError);
    expect(() => compileTemplate("{{process.exit()}}")).toThrow(TemplateError);
  });

  it("compiles JSON bodies with JSON escaping and pre-serialises constants", () => {
    const c = compileJsonBody({ a: 1, b: "x" });
    expect(c.constant?.toString()).toBe('{"a":1,"b":"x"}');
    const d = compileJsonBody({ cartId: "{{cartId}}", qty: 1 });
    expect(d.constant).toBeNull();
    const out = d.render(scope({ vars: { cartId: 'he said "hi"\n' } }));
    expect(JSON.parse(out)).toEqual({ cartId: 'he said "hi"\n', qty: 1 });
  });
});
