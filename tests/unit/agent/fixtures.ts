/**
 * Shared fixtures for the agent unit tests: a small inline OpenAPI contract and a default
 * safety policy built from it.
 */

import type { SafetyPolicy } from "../../../src/engines/agent/safety.js";
import type { ScenarioInput } from "../../../src/engines/agent/scenario.js";
import { type Contract, indexContract, type Operation } from "../../../src/engines/bugs/contract.js";

export const MINI_DOC: Record<string, unknown> = {
  openapi: "3.1.0",
  info: { title: "mini", version: "1" },
  security: [{ bearer: [] }],
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  paths: {
    "/items": {
      get: {
        security: [],
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { name: "q", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": { schema: { type: "object", properties: { items: { type: "array" } } } },
            },
          },
          "400": { description: "bad limit" },
        },
      },
    },
    "/items/{id}": {
      get: {
        security: [],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: { "200": { description: "ok" }, "404": { description: "missing" } },
      },
      delete: {
        summary: "Delete an item (admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "204": { description: "deleted" }, "403": { description: "not admin" } },
      },
    },
    "/orders": {
      post: {
        parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["qty"],
                properties: { qty: { type: "integer", minimum: 1, maximum: 100 } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: {
              "application/json": {
                schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
              },
            },
          },
          "400": { description: "bad qty" },
          "401": { description: "unauth" },
        },
      },
    },
    "/orders/{id}": {
      get: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" }, "404": { description: "not found or not yours" } },
      },
    },
    "/admin/reset": {
      post: { responses: { "204": { description: "reset" } } },
    },
  },
};

export function miniContract(): Contract {
  return indexContract(structuredClone(MINI_DOC), "mini");
}

export function opsOf(c: Contract): Map<string, Operation> {
  return new Map(c.operations.map((o) => [o.key, o]));
}

export function policy(over: Partial<SafetyPolicy> = {}): SafetyPolicy {
  return {
    operations: opsOf(miniContract()),
    roles: ["user", "other", "admin"],
    allowedHosts: ["127.0.0.1", "localhost"],
    mutationsAllowed: true,
    destructiveAllowed: false,
    maxCopies: 10,
    ...over,
  };
}

/** A minimal valid scenario (read-only). */
export function readScenario(over: Partial<ScenarioInput> = {}): ScenarioInput {
  return {
    title: "list items",
    hypothesis: "listing never errors",
    steps: [{ operation: "GET /items", query: { limit: 10 } }],
    assertions: [{ kind: "no-5xx" }],
    expectedClassification: "defect",
    ...over,
  };
}

/** Duplicate-submit scenario on POST /orders. */
export function idempotencyScenario(): ScenarioInput {
  return {
    title: "duplicate submit",
    hypothesis: "same Idempotency-Key returns the same order",
    steps: [
      {
        operation: "POST /orders",
        role: "user",
        headers: { "Idempotency-Key": "{{$nonce}}" },
        body: { qty: 1 },
      },
      {
        operation: "POST /orders",
        role: "user",
        headers: { "Idempotency-Key": "{{$nonce}}" },
        body: { qty: 1 },
      },
    ],
    assertions: [{ kind: "same-json", steps: [0, 1], pointer: "/id", rule: "bugs/idempotency-key-ignored" }],
    expectedClassification: "defect",
  };
}
