/**
 * Property + edge tests for the Bug Hunter JSON Schema helpers (src/engines/bugs/json-schema.ts;
 * docs/04 §7.1–7.2). Ajv is used as the oracle for inferred schemas. Owner: sw-coverage (Wave 5).
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allowsNull,
  createResolver,
  escapePointerSegment,
  getPointer,
  inferSchema,
  jsonType,
  mergeAllOf,
  mergeInferred,
  normalize,
  primaryType,
  schemaTypes,
} from "../../../src/engines/bugs/json-schema.js";

const ajv = new Ajv2020({ strict: false, ownProperties: true });
const conforms = (schema: object, v: unknown) => ajv.validate(schema, v) as boolean;

const json = fc.jsonValue({ maxDepth: 4 }).map((v) => JSON.parse(JSON.stringify(v)) as unknown);

describe("pointers", () => {
  it("escape → getPointer round-trips for arbitrary keys (incl. ~ and /)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), fc.string({ maxLength: 12 }), fc.integer(), (k1, k2, v) => {
        const root = { [k1]: { [k2]: v } };
        const ptr = `/${escapePointerSegment(k1)}/${escapePointerSegment(k2)}`;
        // `%` sequences are percent-decoded first (URI-fragment form); skip those keys
        fc.pre(!/%/.test(ptr));
        expect(getPointer(root, ptr)).toBe(v);
        expect(getPointer(root, `#${ptr}`)).toBe(v);
      }),
    );
  });

  it("arrays, root, percent-encoding, malformed escapes and dead ends", () => {
    const root = { a: [10, { "b c": 2 }], "x/y": { "m~n": 3 } };
    expect(getPointer(root, "#")).toBe(root);
    expect(getPointer(root, "")).toBe(root);
    expect(getPointer(root, "/a/0")).toBe(10);
    expect(getPointer(root, "#/a/1/b%20c")).toBe(2);
    expect(getPointer(root, "/x~1y/m~0n")).toBe(3);
    expect(getPointer(root, "/a/0/deeper")).toBeUndefined();
    expect(getPointer(root, "/missing/x")).toBeUndefined();
    expect(getPointer({ "%E0%A4%A": 1 }, "/%E0%A4%A")).toBe(1); // invalid percent-encoding: raw kept
  });
});

describe("resolver", () => {
  const root = {
    components: {
      schemas: {
        A: { $ref: "#/components/schemas/B" },
        B: { type: "string", minLength: 1 },
        Loop1: { $ref: "#/components/schemas/Loop2" },
        Loop2: { $ref: "#/components/schemas/Loop1" },
        Base: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], minimum: 1, maximum: 100 },
        Ext: { allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { n: { type: "string" } }, required: ["n"], minimum: 5, maximum: 50 }] },
      },
    },
  };
  const r = createResolver(root);

  it("follows chains, merges siblings, handles booleans, externals, missing targets and cycles", () => {
    expect(r.resolve({ $ref: "#/components/schemas/A" })).toEqual({ type: "string", minLength: 1 });
    expect(r.resolve({ $ref: "#/components/schemas/B", description: "d", minLength: 3 })).toEqual({ type: "string", minLength: 3, description: "d" });
    expect(r.resolve(true)).toEqual({});
    expect(r.resolve(undefined)).toEqual({});
    expect(r.resolve(false)).toEqual({ not: {} });
    expect(r.resolve("str")).toEqual({});
    expect(r.resolve({ $ref: "other.yaml#/X" })).toEqual({ $ref: "other.yaml#/X" });
    expect(r.resolve({ $ref: "#/nope" })).toEqual({});
    expect(r.resolve({ $ref: "#/components/schemas/Loop1" })).toEqual({}); // bounded, no hang
  });

  it("allOf merging: union of properties/required, tightest numeric bounds, nested allOf", () => {
    const m = normalize({ $ref: "#/components/schemas/Ext" }, r);
    expect(m.properties).toEqual({ id: { type: "integer" }, n: { type: "string" } });
    expect(m.required).toEqual(["id", "n"]);
    expect(m.minimum).toBe(5);
    expect(m.maximum).toBe(50);
    expect(m.type).toBe("object");
    const nested = mergeAllOf({ allOf: [{ allOf: [{ minLength: 2 }, { minLength: 4, maxLength: 9 }] }, { maxLength: 7 }] }, r);
    expect(nested).toMatchObject({ minLength: 4, maxLength: 7 });
    expect(mergeAllOf({ type: "string" }, r)).toEqual({ type: "string" });
    expect(normalize({ type: "number" }, r)).toEqual({ type: "number" });
  });

  it("property: merged allOf bounds are never looser than any part", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ minimum: fc.integer(), maximum: fc.integer() }), { minLength: 1, maxLength: 6 }), (parts) => {
        const m = mergeAllOf({ allOf: parts }, r);
        expect(m.minimum).toBe(Math.max(...parts.map((p) => p.minimum)));
        expect(m.maximum).toBe(Math.min(...parts.map((p) => p.maximum)));
      }),
    );
  });

  it("a self-feeding allOf queue is bounded", () => {
    const evil = { components: { schemas: { X: { allOf: [{ $ref: "#/components/schemas/X" }] } } } };
    const r2 = createResolver(evil);
    expect(() => normalize({ $ref: "#/components/schemas/X" }, r2)).not.toThrow();
  });
});

describe("types", () => {
  it("schemaTypes infers from keywords", () => {
    expect(schemaTypes({ type: "string" })).toEqual(["string"]);
    expect(schemaTypes({ type: ["integer", "null", 3] })).toEqual(["integer", "null"]);
    expect(schemaTypes({ const: 1.5 })).toEqual(["number"]);
    expect(schemaTypes({ enum: [1, "a", 2] })).toEqual(["integer", "string"]);
    expect(schemaTypes({ enum: [] })).toEqual([]);
    expect(schemaTypes({ required: ["a"] })).toEqual(["object"]);
    expect(schemaTypes({ prefixItems: [] })).toEqual(["array"]);
    expect(schemaTypes({ maximum: 3 })).toEqual(["number"]);
    expect(schemaTypes({ format: "uuid" })).toEqual(["string"]);
    expect(schemaTypes({ pattern: "^a" })).toEqual(["string"]);
    expect(schemaTypes({})).toEqual([]);
    expect(primaryType({ type: ["null", "string"] })).toBe("string");
    expect(primaryType({})).toBeUndefined();
    expect(allowsNull({ nullable: true })).toBe(true);
    expect(allowsNull({ enum: ["a", null] })).toBe(true);
    expect(allowsNull({ type: ["string", "null"] })).toBe(true);
    expect(allowsNull({ type: "string" })).toBe(false);
  });

  it("jsonType of every JSON value is consistent with Ajv's type keyword", () => {
    fc.assert(
      fc.property(json, (v) => {
        expect(conforms({ type: jsonType(v) }, v)).toBe(true);
      }),
    );
  });
});

describe("inferSchema / mergeInferred", () => {
  it("property: every value conforms to the schema inferred from it", () => {
    fc.assert(
      fc.property(json, (v) => {
        expect(conforms(inferSchema(v), v)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("property: the merge of two inferred schemas accepts both values", () => {
    fc.assert(
      fc.property(json, json, (a, b) => {
        const m = mergeInferred(inferSchema(a), inferSchema(b));
        expect(conforms(m, a)).toBe(true);
        expect(conforms(m, b)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("property: arrays infer an items schema accepting every element of the first 20", () => {
    fc.assert(
      fc.property(fc.array(json, { maxLength: 20 }), (arr) => {
        expect(conforms(inferSchema(arr), arr)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("required becomes the intersection; integer+number widens to number; depth bounded", () => {
    const m = mergeInferred(inferSchema({ a: 1, b: 2 }), inferSchema({ a: 1.5, c: "x" }));
    expect(m.required).toEqual(["a"]);
    expect((m.properties as any).a).toEqual({ type: "number" });
    expect(mergeInferred({ type: "array" }, { type: "array", items: { type: "string" } })).toEqual({ type: "array", items: { type: "string" } });
    expect(mergeInferred({ type: "array", items: { type: "string" } }, { type: "array" })).toEqual({ type: "array", items: { type: "string" } });
    expect(mergeInferred({ type: "string" }, { type: "string" })).toEqual({ type: "string" });
    expect(mergeInferred({ type: ["null", "string"] }, { type: "integer" })).toEqual({ type: ["integer", "null", "string"] });
    expect(mergeInferred({}, {})).toEqual({});
    expect(mergeInferred({ description: "x" }, { title: "y" })).toEqual({});
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(() => inferSchema(deep)).not.toThrow();
    const wide = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(inferSchema(wide).properties as object)).toHaveLength(100);
  });
});
