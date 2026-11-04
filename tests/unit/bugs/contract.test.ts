import { describe, expect, it } from "vitest";
import {
  type CaseStep,
  conformance,
  diffCommon,
  envelopeOf,
  failureFingerprint,
  modelReadExpectations,
  rebuildModelExpectations,
} from "../../../src/engines/bugs/cases.js";
import {
  indexContract,
  loadContract,
  matchesPattern,
  matchResponse,
} from "../../../src/engines/bugs/contract.js";
import { wireCoerce } from "../../../src/engines/bugs/generate.js";
import { splitCommand } from "../../../src/engines/bugs/hooks.js";
import type { Exchange } from "../../../src/engines/bugs/http.js";
import { createResolver } from "../../../src/engines/bugs/json-schema.js";
import { ValidatorCache } from "../../../src/engines/bugs/validator.js";

function ex(status: number, json?: unknown, contentType = "application/json"): Exchange {
  const e: Exchange = {
    operation: "",
    method: "GET",
    url: "http://127.0.0.1/x",
    requestHeaders: {},
    status,
    responseHeaders: { "content-type": contentType },
    contentType,
    durationMs: 1,
    tStart: 0,
    tEnd: 1,
    rateLimitedRetries: 0,
  };
  if (json !== undefined) {
    e.json = json;
    e.responseBody = JSON.stringify(json);
  }
  return e;
}

const OAS31 = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {
    "/things/{id}": {
      get: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items"],
                  properties: { items: { type: "array", items: { $ref: "#/components/schemas/Thing" } } },
                },
              },
            },
          },
          "404": { description: "not found" },
          "4XX": { description: "client error" },
        },
      },
    },
    "/orders": {
      post: {
        parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "201": { description: "created" } },
      },
    },
  },
  components: {
    schemas: { Thing: { type: "object", required: ["price"], properties: { price: { type: "number" } } } },
  },
};

describe("contract loading", () => {
  it("indexes shop-express (YAML, 3.1, security, idempotency header)", async () => {
    const c = await loadContract("examples/shop-express/openapi.yaml");
    expect(c.version).toBe("3.1");
    const keys = c.operations.map((o) => o.key);
    expect(keys).toEqual(
      expect.arrayContaining(["GET /products/{id}", "POST /orders", "GET /orders/{id}", "GET /admin/stats"]),
    );
    const post = c.operations.find((o) => o.key === "POST /orders");
    expect(post?.secured).toBe(true);
    expect(post?.mutating).toBe(true);
    expect(post?.idempotencyHeader).toBe("Idempotency-Key");
    expect(c.operations.find((o) => o.key === "GET /products")?.secured).toBe(false);
  });

  it("converts Swagger 2.0 best-effort (body param, definitions, response schema)", async () => {
    const c = await loadContract({
      swagger: "2.0",
      info: { title: "s2", version: "1" },
      produces: ["application/json"],
      paths: {
        "/pets": {
          post: {
            parameters: [
              { name: "body", in: "body", required: true, schema: { $ref: "#/definitions/Pet" } },
              { name: "limit", in: "query", type: "integer", minimum: 1, maximum: 10 },
            ],
            responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Pet" } } },
          },
        },
      },
      definitions: {
        Pet: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            age: { type: "integer", minimum: 0, exclusiveMinimum: true },
          },
        },
      },
    });
    expect(c.version).toBe("2.0");
    const op = c.operations[0];
    expect(op?.body?.required).toBe(true);
    expect(op?.params.find((p) => p.name === "limit")?.schema).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 10,
    });
    const schema = matchResponse(op as NonNullable<typeof op>, 200)?.content["application/json"]?.schema;
    expect(c.validators.isValid(schema, { name: "rex", age: 1 })).toBe(true);
    expect(c.validators.isValid(schema, { name: "rex", age: 0 })).toBe(false); // boolean exclusiveMinimum normalised
    expect(c.validators.isValid(schema, { age: 2 })).toBe(false);
  });

  it("validates circular refs and OpenAPI 3.0 nullable", () => {
    const c = indexContract({
      openapi: "3.0.3",
      info: { title: "c", version: "1" },
      paths: {},
      components: {
        schemas: {
          Node: {
            type: "object",
            required: ["v"],
            properties: {
              v: { type: "integer" },
              next: { $ref: "#/components/schemas/Node" },
              label: { type: "string", nullable: true },
            },
          },
        },
      },
    });
    const s = { $ref: "#/components/schemas/Node" };
    expect(c.validators.isValid(s, { v: 1, next: { v: 2, next: { v: 3, label: null } } })).toBe(true);
    expect(c.validators.isValid(s, { v: 1, next: { v: "x" } })).toBe(false);
    expect(c.validators.validate(s, { v: 1, next: { v: "x" } })[0]?.pointer).toBe("/next/v");
  });

  it("compiles each schema once (LRU by hash)", () => {
    const v = new ValidatorCache({ dialect: "2020-12" });
    const s = { type: "integer", minimum: 1 };
    for (let i = 0; i < 10; i++) v.isValid({ ...s }, i);
    expect(v.compiled).toBe(1);
    expect(v.hits).toBe(9);
  });

  it("matches operations by pattern and statuses by range/default", () => {
    const c = indexContract(OAS31);
    const op = c.operations[0] as NonNullable<(typeof c.operations)[0]>;
    expect(matchesPattern(op, "GET /things/{id}")).toBe(true);
    expect(matchesPattern(op, "* /things/*")).toBe(true);
    expect(matchesPattern(op, "POST /things/{id}")).toBe(false);
    expect(matchResponse(op, 404)?.status).toBe("404");
    expect(matchResponse(op, 418)?.status).toBe("4XX");
    expect(matchResponse(op, 500)).toBeUndefined();
  });
});

describe("conformance & false-positive controls", () => {
  const c = indexContract(OAS31);
  const op = c.operations.find((o) => o.key === "GET /things/{id}") as NonNullable<(typeof c.operations)[0]>;

  it("documented statuses (404) are never failures", () => {
    expect(conformance(op, ex(404, { error: "nf" }), "valid", 0, undefined, c)).toEqual([]);
  });
  it("5xx on valid input → server-error; on invalid field → boundary rule; malformed body → invalid-input rule", () => {
    expect(conformance(op, ex(500), "valid", 0, undefined, c)[0]?.ruleId).toBe("bugs/server-error");
    expect(conformance(op, ex(500), "invalid", 0, "path:id", c)[0]?.ruleId).toBe(
      "bugs/server-error-on-boundary",
    );
    expect(conformance(op, ex(500), "invalid", 0, "body:malformed-json", c)[0]?.ruleId).toBe(
      "bugs/server-error-on-invalid-input",
    );
  });
  it("2xx on invalid input is only an observation", () => {
    const f = conformance(op, ex(200, { items: [] }), "invalid", 0, "path:id", c);
    expect(f.map((x) => [x.ruleId, x.observation])).toEqual([["bugs/accepts-invalid-input", true]]);
  });
  it("schema violations carry normalised pointers and dedupe by fingerprint", () => {
    const body = { items: [{ price: 1 }, { price: "2" }, { price: "3" }] };
    const f = conformance(op, ex(200, body), "valid", 0, undefined, c);
    expect(f).toHaveLength(1);
    expect(f[0]?.pointer).toBe("/items/*/price");
    expect(failureFingerprint("bugs/schema-mismatch", op.key, "/items/0/price", "type")).toBe(
      failureFingerprint("bugs/schema-mismatch", op.key, "/items/7/price", "type"),
    );
    expect(failureFingerprint("bugs/schema-mismatch", op.key, "/items/0/price", "type")).not.toBe(
      failureFingerprint("bugs/schema-mismatch", op.key, "/items/0/name", "type"),
    );
  });
  it("content-type mismatch and undocumented status", () => {
    expect(conformance(op, ex(200, "x", "text/html"), "valid", 0, undefined, c)[0]?.ruleId).toBe(
      "bugs/content-type-mismatch",
    );
    const opPost = c.operations.find((o) => o.key === "POST /orders") as NonNullable<
      (typeof c.operations)[0]
    >;
    expect(conformance(opPost, ex(302), "valid", 0, undefined, c)[0]?.ruleId).toBe(
      "bugs/undocumented-status",
    );
    expect(conformance(opPost, ex(414), "valid", 0, undefined, c)[0]?.observation).toBe(true);
  });
});

describe("helpers", () => {
  it("splitCommand parses argv without a shell", () => {
    expect(splitCommand(`node scripts/reset.js --db "my db" 'x y' a\\ b`)).toEqual([
      "node",
      "scripts/reset.js",
      "--db",
      "my db",
      "x y",
      "a b",
    ]);
    expect(splitCommand(`npm run "" end`)).toEqual(["npm", "run", "", "end"]);
  });
  it("wireCoerce judges parameters as the server sees them", () => {
    const r = createResolver({});
    expect(wireCoerce("12", { type: "integer" }, r)).toBe(12);
    expect(wireCoerce({ a: 1 }, { type: "string" }, r)).toBe('{"a":1}');
    expect(wireCoerce("true", { type: "boolean" }, r)).toBe(true);
    expect(wireCoerce(["1", "2"], { type: "array", items: { type: "integer" } }, r)).toEqual([1, 2]);
  });
  it("model expectations are recomputed for subsequences (sound ddmin)", () => {
    const req = {
      operation: "x",
      method: "GET",
      path: "/i/{id}",
      pathParams: {},
      query: {},
      headers: {},
      body: { kind: "none" as const },
    };
    const steps: CaseStep[] = [
      { request: req, expect: "none", model: { cmd: "create", v: "a", fields: { n: 1 } } },
      { request: req, expect: "none", model: { cmd: "delete", v: "a" } },
      { request: req, expect: "none", model: { cmd: "read", v: "a" } },
    ];
    expect(rebuildModelExpectations(steps)[2]?.expect).toMatchObject({ status: [404, 410] });
    const sub = rebuildModelExpectations([steps[0] as CaseStep, steps[2] as CaseStep]);
    expect(sub[1]?.expect).toMatchObject({ status: [200] });
    expect(sub[1]?.expectJson).toEqual([{ pointer: "/n", equals: 1, ifPresent: true }]);
    // An enveloped resource ({"item": {...}}, id at /item/id) is compared inside the envelope.
    const wrapped = rebuildModelExpectations([
      steps[0] as CaseStep,
      { request: req, expect: "none", model: { cmd: "read", v: "a", base: "/item" } },
    ]);
    expect(wrapped[1]?.expectJson).toEqual([{ pointer: "/item/n", equals: 1, ifPresent: true }]);
  });
  it("model read-back: envelope from the id pointer; escaped keys", () => {
    expect(envelopeOf("/transaction/id")).toBe("/transaction");
    expect(envelopeOf("/id")).toBe("");
    expect(envelopeOf("/data/item/id")).toBe("/data/item");
    expect(modelReadExpectations({ "a/b": 1, "c~d": 2 }, "/x")).toEqual([
      { pointer: "/x/a~1b", equals: 1, ifPresent: true },
      { pointer: "/x/c~0d", equals: 2, ifPresent: true },
    ]);
  });
  it("diffCommon compares keys present in both", () => {
    expect(diffCommon({ a: 1, b: { c: 2 }, only: 1 }, { a: 1, b: { c: 3 } })).toEqual(["/b/c"]);
  });
});
