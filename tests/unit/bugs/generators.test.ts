import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Dictionary } from "../../../src/engines/bugs/dictionary.js";
import { schemaToArbitrary } from "../../../src/engines/bugs/generators/arbitrary.js";
import {
  boundaryValues,
  equivalenceValues,
  objectVariants,
} from "../../../src/engines/bugs/generators/boundary.js";
import { negativeMutations } from "../../../src/engines/bugs/generators/mutations.js";
import { sampleValid } from "../../../src/engines/bugs/generators/sample.js";
import { createResolver } from "../../../src/engines/bugs/json-schema.js";
import { ValidatorCache } from "../../../src/engines/bugs/validator.js";

const resolver = createResolver({});
const ctx = { resolver };
const values = (s: unknown): unknown[] => boundaryValues(s, ctx).map((c) => c.value);

describe("boundary values per keyword", () => {
  it("integer 1..100 → 0,1,2,99,100,101 (+ fraction)", () => {
    const cases = boundaryValues({ type: "integer", minimum: 1, maximum: 100 }, ctx);
    expect(cases.filter((c) => c.label !== "fraction").map((c) => c.value)).toEqual([0, 1, 2, 99, 100, 101]);
    expect(cases.filter((c) => !c.expectValid).map((c) => c.value)).toEqual([0, 101, 1.5]);
  });
  it("exclusive bounds (2020 numeric form)", () => {
    expect(values({ type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 10 }).slice(0, 6)).toEqual([
      0, 1, 2, 8, 9, 10,
    ]);
  });
  it("exclusive bounds (OpenAPI 3.0 boolean form)", () => {
    expect(values({ type: "integer", minimum: 0, exclusiveMinimum: true }).slice(0, 3)).toEqual([0, 1, 2]);
  });
  it("only minimum", () => {
    expect(values({ type: "integer", minimum: 5 })).toEqual([4, 5, 6, 1.5]);
  });
  it("minLength / maxLength", () => {
    const cs = boundaryValues({ type: "string", minLength: 2, maxLength: 5 }, ctx);
    const byLabel = Object.fromEntries(cs.map((c) => [c.label, c]));
    expect(String(byLabel["minLength-1"]?.value).length).toBe(1);
    expect(String(byLabel.minLength?.value).length).toBe(2);
    expect(String(byLabel["maxLength+1"]?.value).length).toBe(6);
    expect(byLabel["maxLength+1"]?.expectValid).toBe(false);
  });
  it("unbounded string gets empty + long + unicode", () => {
    const labels = boundaryValues({ type: "string" }, ctx).map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(["empty", "long", "unicode"]));
  });
  it("format → valid sample + near miss", () => {
    const cs = boundaryValues({ type: "string", format: "email" }, ctx);
    expect(cs.map((c) => c.expectValid)).toEqual([true, false]);
  });
  it("minItems / maxItems", () => {
    const cs = boundaryValues({ type: "array", items: { type: "integer" }, minItems: 2, maxItems: 3 }, ctx);
    const lens = Object.fromEntries(cs.map((c) => [c.label, (c.value as unknown[]).length]));
    expect(lens).toMatchObject({
      empty: 0,
      "minItems-1": 1,
      minItems: 2,
      "minItems+1": 3,
      maxItems: 3,
      "maxItems+1": 4,
    });
  });
  it("enum, wrong types, null and nullable", () => {
    const cs = equivalenceValues({ type: "string", enum: ["a", "b"] }, ctx);
    expect(cs.filter((c) => c.keyword === "enum").map((c) => c.value)).toEqual(["a", "b", "sw-not-in-enum"]);
    expect(cs.some((c) => c.label === "wrong-type:integer")).toBe(true);
    expect(cs.find((c) => c.label === "null")?.expectValid).toBe(false);
    expect(
      equivalenceValues({ type: "string", nullable: true }, ctx).find((c) => c.label === "null")?.expectValid,
    ).toBe(true);
  });
  it("labels agree with Ajv for numeric/string/array keywords", () => {
    const v = new ValidatorCache({ dialect: "2020-12" });
    const schemas = [
      { type: "integer", minimum: 1, maximum: 100 },
      { type: "number", minimum: 0, maximum: 10 },
      { type: "string", minLength: 3, maxLength: 8 },
      { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
      { type: "integer", exclusiveMinimum: 0 },
    ];
    for (const s of schemas)
      for (const c of boundaryValues(s, ctx))
        expect([s, c.label, v.isValid(s, c.value)]).toEqual([s, c.label, c.expectValid]);
  });
  it("object variants: per-property boundaries and required omission", () => {
    const schema = {
      type: "object",
      required: ["productId", "qty"],
      properties: {
        productId: { type: "integer", minimum: 1 },
        qty: { type: "integer", minimum: 1, maximum: 100 },
      },
    };
    const base = sampleValid(schema, ctx);
    expect(base).toEqual({ productId: 1, qty: 1 });
    const b = objectVariants(schema, base, ctx, "boundary");
    const qty = b.filter((x) => x.pointer === "/qty").map((x) => (x.value as { qty: number }).qty);
    expect(qty).toEqual([0, 1, 2, 99, 100, 101, 1.5]);
    const e = objectVariants(schema, base, ctx, "equivalence");
    expect(
      e
        .filter((x) => x.label === "missing-required")
        .map((x) => x.pointer)
        .sort(),
    ).toEqual(["/productId", "/qty"]);
  });
});

describe("sampleValid", () => {
  it("prefers dictionary, then example/default/enum", () => {
    const dict = new Dictionary({ productId: [7, 8] });
    expect(sampleValid({ type: "integer" }, { resolver, dict }, "productId")).toBe(7);
    expect(sampleValid({ type: "integer", example: 3 }, ctx)).toBe(3);
    expect(sampleValid({ type: "string", enum: ["x", "y"] }, ctx)).toBe("x");
  });
  it("dictionary resolves {id} path params from the owning resource", () => {
    const dict = new Dictionary();
    dict.harvest("/products", { items: [{ id: 4 }, { id: 5 }] });
    expect(dict.lookup("id", "/products/{id}")).toEqual([4, 5]);
    expect(dict.lookup("productId")).toEqual([4, 5]);
  });
  it("resolves $ref and allOf against the document", () => {
    const doc = {
      components: {
        schemas: {
          Base: { type: "object", required: ["a"], properties: { a: { type: "integer", minimum: 2 } } },
          Ext: {
            allOf: [
              { $ref: "#/components/schemas/Base" },
              { type: "object", required: ["b"], properties: { b: { type: "string", format: "uuid" } } },
            ],
          },
        },
      },
    };
    const r = createResolver(doc);
    const v = sampleValid({ $ref: "#/components/schemas/Ext" }, { resolver: r }) as Record<string, unknown>;
    expect(v.a).toBe(2);
    expect(typeof v.b).toBe("string");
    const vc = new ValidatorCache({ dialect: "2020-12", document: doc });
    expect(vc.isValid({ $ref: "#/components/schemas/Ext" }, v)).toBe(true);
  });
});

describe("JSON Schema → fast-check arbitrary", () => {
  const vc = new ValidatorCache({ dialect: "2020-12" });
  // Random schemas built from supported keywords.
  const leaf = fc.oneof(
    fc.record({
      type: fc.constant("integer"),
      minimum: fc.integer({ min: -50, max: 0 }),
      maximum: fc.integer({ min: 0, max: 50 }),
    }),
    fc.record({
      type: fc.constant("number"),
      exclusiveMinimum: fc.constant(0),
      maximum: fc.integer({ min: 1, max: 1000 }),
    }),
    fc.record({
      type: fc.constant("string"),
      minLength: fc.integer({ min: 0, max: 3 }),
      maxLength: fc.integer({ min: 3, max: 10 }),
    }),
    fc.record({
      type: fc.constant("string"),
      format: fc.constantFrom("uuid", "date-time", "date", "email", "ipv4", "uri"),
    }),
    fc.record({ type: fc.constant("string"), pattern: fc.constantFrom("^[a-z]{2,5}$", "^SKU-[0-9]{3}$") }),
    fc.record({
      enum: fc.uniqueArray(fc.oneof(fc.string({ maxLength: 4 }), fc.integer()), {
        minLength: 1,
        maxLength: 4,
      }),
    }),
    fc.constant({ type: "boolean" }),
    fc.constant({ type: ["string", "null"], maxLength: 3 }),
    fc.record({
      type: fc.constant("integer"),
      multipleOf: fc.integer({ min: 2, max: 7 }),
      minimum: fc.constant(0),
      maximum: fc.constant(100),
    }),
  );
  const schemaArb = fc.letrec((tie) => ({
    node: fc.oneof({ maxDepth: 3, depthSize: "small" }, leaf, tie("arr"), tie("obj")),
    arr: fc.record({
      type: fc.constant("array"),
      items: tie("node"),
      minItems: fc.integer({ min: 0, max: 2 }),
      maxItems: fc.integer({ min: 2, max: 4 }),
    }),
    obj: fc.dictionary(fc.constantFrom("a", "b", "c", "d"), tie("node"), { maxKeys: 4 }).chain((props) =>
      fc.record({
        type: fc.constant("object"),
        properties: fc.constant(props),
        required: fc.subarray(Object.keys(props)),
        additionalProperties: fc.boolean(),
      }),
    ),
  }));

  it("always produces schema-valid values (validated by Ajv)", () => {
    fc.assert(
      fc.property(schemaArb.node, fc.integer(), (schema, seed) => {
        const arb = schemaToArbitrary(schema, { resolver });
        for (const v of fc.sample(arb, { numRuns: 15, seed })) {
          const errs = vc.validate(schema, v);
          if (errs.length > 0)
            throw new Error(`${JSON.stringify(schema)} -> ${JSON.stringify(v)}: ${errs[0]?.message}`);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("filter guarantees validity for oneOf exclusivity", () => {
    const schema = {
      oneOf: [
        { type: "integer", minimum: 0, maximum: 10 },
        { type: "integer", minimum: 5, maximum: 20 },
      ],
    };
    const arb = schemaToArbitrary(schema, { resolver, isValid: (v) => vc.isValid(schema, v) });
    for (const v of fc.sample(arb, { numRuns: 50, seed: 3 })) expect(vc.isValid(schema, v)).toBe(true);
  });
});

describe("negative mutations", () => {
  it("are bounded and shape-only", () => {
    const ms = negativeMutations({ name: "x", nested: { tag: "y" }, n: 1 }, { maxBytes: 8192 });
    const ops = new Set(ms.map((m) => m.operator));
    for (const o of [
      "malformed-json",
      "wrong-content-type",
      "extra-field",
      "oversized-string",
      "injection-shape",
    ])
      expect(ops.has(o)).toBe(true);
    for (const m of ms) {
      const size =
        m.body.kind === "raw"
          ? m.body.text.length
          : JSON.stringify(m.body.kind === "json" ? m.body.value : "").length;
      expect(size).toBeLessThanOrEqual(8192 + 64);
    }
  });
});
