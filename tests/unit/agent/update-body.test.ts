/**
 * updateBody (sw-gaps-w8 gap 3): body of the agent's read-after-update probe — one free-text field
 * changed within the update operation's schema, undocumented fields dropped.
 */
import { describe, expect, it } from "vitest";
import { updateBody } from "../../../src/engines/agent/planner/heuristic.js";
import { createResolver } from "../../../src/engines/bugs/json-schema.js";

const R = createResolver({});

describe("updateBody", () => {
  it("orders-like: keeps only the update fields, changes the free-text note first", () => {
    const schema = {
      type: "object",
      required: ["shippingAddress", "note"],
      properties: {
        shippingAddress: { type: "string", minLength: 1, maxLength: 200 },
        note: { type: "string", maxLength: 200 },
      },
    };
    const u = updateBody(
      { sku: "MUG-002", quantity: 1, shippingAddress: "1 Probe St", note: "sw probe" },
      schema,
      R,
    );
    expect(u?.pointer).toBe("/note");
    expect(u?.body).toEqual({ shippingAddress: "1 Probe St", note: "sw probe (sw update)" });
  });

  it("wrapped body: nested free-text field; identifiers, enums and patterned strings are never changed", () => {
    const schema = {
      type: "object",
      properties: {
        article: {
          type: "object",
          properties: {
            slug: { type: "string" },
            kind: { type: "string", enum: ["a", "b"] },
            code: { type: "string", pattern: "^[A-Z]+$" },
            description: { type: "string" },
          },
        },
      },
    };
    const u = updateBody({ article: { slug: "s", kind: "a", code: "X", description: "d" } }, schema, R);
    expect(u?.pointer).toBe("/article/description");
    const only = updateBody({ article: { slug: "s", kind: "a" } }, schema, R);
    expect(only).toBeUndefined();
  });

  it("respects maxLength and refuses when a required update field is missing from the body", () => {
    const short = {
      type: "object",
      properties: { note: { type: "string", maxLength: 9 } },
    };
    expect(updateBody({ note: "x" }, short, R)?.value).toBe("sw update");
    const req = {
      type: "object",
      required: ["note", "owner"],
      properties: { note: { type: "string" }, owner: {} },
    };
    expect(updateBody({ note: "x" }, req, R)).toBeUndefined();
    expect(updateBody("not an object", undefined, R)).toBeUndefined();
  });
});
