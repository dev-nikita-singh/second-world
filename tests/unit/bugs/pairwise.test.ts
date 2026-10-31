import { describe, expect, it } from "vitest";
import { ipog, uncoveredPairs } from "../../../src/engines/bugs/algorithms/ipog.js";
import { indexContract } from "../../../src/engines/bugs/contract.js";
import { Dictionary } from "../../../src/engines/bugs/dictionary.js";
import { type GenContext, pairwiseCases } from "../../../src/engines/bugs/generate.js";
import {
  ABSENT,
  applyBodyRow,
  bodyConstraint,
  bodyFactors,
  factorActive,
  INACTIVE,
  PRESENT,
} from "../../../src/engines/bugs/generators/pairwise.js";
import { parseBugsInput } from "../../../src/engines/bugs/index.js";
import { createResolver, getPointer } from "../../../src/engines/bugs/json-schema.js";
import { ValidatorCache } from "../../../src/engines/bugs/validator.js";

const resolver = createResolver({});
const ctx = { resolver };

const ORDER = {
  type: "object",
  required: ["kind", "qty", "items"],
  properties: {
    kind: { type: "string", enum: ["standard", "express", "pickup"] },
    gift: { type: "boolean" },
    qty: { type: "integer", minimum: 1, maximum: 10 },
    note: { type: "string", minLength: 2, maxLength: 20 },
    id: { type: "string", readOnly: true },
    shipping: {
      type: "object",
      required: ["method"],
      properties: {
        method: { type: "string", enum: ["post", "courier"] },
        insured: { type: "boolean" },
        address: {
          type: "object",
          properties: {
            country: { type: "string", enum: ["DE", "FR"] },
            deep: { type: "object", properties: { x: { type: "integer" } } },
          },
        },
      },
    },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["productId"],
        properties: {
          productId: { type: "integer", minimum: 1 },
          priority: { type: "string", enum: ["low", "high"] },
        },
      },
    },
  },
};

/** Value actually present in a generated body for a factor (ABSENT marker when omitted). */
function observed(body: unknown, segs: (string | number)[]): unknown {
  let cur: unknown = body;
  for (const s of segs) {
    if (cur === null || typeof cur !== "object" || !(String(s) in (cur as object))) return ABSENT;
    cur = (cur as Record<string, unknown>)[s as string];
  }
  return cur;
}

function matches(fv: unknown, got: unknown): boolean {
  if (fv === INACTIVE) return got === ABSENT;
  if (fv === ABSENT) return got === ABSENT;
  if (fv === PRESENT) return got !== ABSENT && typeof got === "object" && got !== null;
  return JSON.stringify(fv) === JSON.stringify(got) && got !== ABSENT;
}

describe("pairwise over request-body fields", () => {
  const set = bodyFactors(ORDER, ctx, { maxDepth: 3, maxFactors: 20, maxValues: 4 });
  const sizes = set.factors.map((f) => f.values.length);
  const constraint = bodyConstraint(set.factors);
  const rows = ipog(sizes, { constraint });
  const bodies = rows.map((r) => applyBodyRow(set, r));

  it("derives factors: enums, booleans, boundaries, optional absent, nested presence (bounded depth)", () => {
    const byPtr = Object.fromEntries(set.factors.map((f) => [f.pointer, f]));
    expect(byPtr["/kind"]?.values).toEqual(["standard", "express", "pickup"]);
    expect(byPtr["/gift"]?.values).toEqual([true, false, ABSENT]);
    expect(byPtr["/qty"]?.values).toEqual(expect.arrayContaining([1, 2, 9]));
    expect(byPtr["/qty"]?.values).not.toContain(ABSENT);
    expect(
      (byPtr["/note"]?.values ?? []).filter((v) => typeof v === "string").map((v) => (v as string).length),
    ).toEqual(expect.arrayContaining([2, 3]));
    expect(byPtr["/note"]?.values).toContain(ABSENT);
    expect(byPtr["/shipping"]?.values).toEqual([PRESENT, ABSENT]);
    expect(byPtr["/shipping/method"]?.parent).toBe(set.factors.indexOf(byPtr["/shipping"] as never));
    expect(byPtr["/shipping/address"]?.values).toEqual([INACTIVE, PRESENT, ABSENT]);
    expect(byPtr["/shipping/address/country"]?.values).toEqual([INACTIVE, "DE", "FR", ABSENT]);
    expect(byPtr["/shipping/address/deep"]?.kind).toBe("leaf"); // depth cap: presence only, no descent
    expect(byPtr["/shipping/address/deep/x"]).toBeUndefined();
    expect(byPtr["/items/0/priority"]?.values).toEqual(["low", "high", ABSENT]);
    expect(byPtr["/id"]).toBeUndefined(); // readOnly
  });

  it("the covering array covers every feasible pair of values", () => {
    expect(uncoveredPairs(sizes, rows, constraint)).toEqual([]);
  });

  it("every pair of values appears together in at least one generated body", () => {
    const fs = set.factors;
    for (let i = 0; i < fs.length; i++)
      for (let j = i + 1; j < fs.length; j++)
        for (const [vi, a] of (fs[i]?.values ?? []).entries())
          for (const [vj, b] of (fs[j]?.values ?? []).entries()) {
            // Pairs below an absent ancestor are never sent: skip infeasible ones.
            const probe: (number | undefined)[] = new Array(fs.length).fill(undefined);
            probe[i] = vi;
            probe[j] = vj;
            if (!constraint(probe) || a === INACTIVE || b === INACTIVE) continue;
            const hit = rows.some(
              (r, k) =>
                factorActive(fs, r, 0, i) &&
                factorActive(fs, r, 0, j) &&
                matches(a, observed(bodies[k], fs[i]?.segs ?? [])) &&
                matches(b, observed(bodies[k], fs[j]?.segs ?? [])),
            );
            expect(hit, `${fs[i]?.pointer}=${String(a)} × ${fs[j]?.pointer}=${String(b)}`).toBe(true);
          }
  });

  it("all generated bodies are schema-valid and far fewer than exhaustive", () => {
    const v = new ValidatorCache({ dialect: "2020-12" });
    for (const b of bodies) expect(v.validate(ORDER, b)).toEqual([]);
    const exhaustive = sizes.reduce((a, b) => a * b, 1);
    expect(rows.length).toBeLessThan(40);
    expect(rows.length * 50).toBeLessThan(exhaustive);
  });

  it("is deterministic", () => {
    const again = bodyFactors(ORDER, ctx, { maxDepth: 3, maxFactors: 20, maxValues: 4 });
    const rows2 = ipog(
      again.factors.map((f) => f.values.length),
      { constraint: bodyConstraint(again.factors) },
    );
    expect(rows2.map((r) => applyBodyRow(again, r))).toEqual(bodies);
  });

  it("an absent optional object removes its whole subtree", () => {
    const m = set.factors.findIndex((f) => f.pointer === "/shipping/method");
    const k = rows.findIndex((r) => !factorActive(set.factors, r, 0, m));
    expect(k).toBeGreaterThanOrEqual(0);
    expect(getPointer(bodies[k], "/shipping")).toBeUndefined();
  });
});

describe("pairwiseCases (params + body in one covering array)", () => {
  const doc = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/orders": {
        post: {
          parameters: [{ name: "dryRun", in: "query", schema: { type: "boolean" } }],
          requestBody: { required: true, content: { "application/json": { schema: ORDER } } },
          responses: { "201": { description: "ok" } },
        },
      },
    },
  };
  const gen = (seed: number, maxCases = 40) => {
    const contract = indexContract(doc);
    const g: GenContext = {
      contract,
      dict: new Dictionary(),
      rng: {
        next: () => 0,
        int: (a: number) => a,
        exponential: () => 1,
        pick: <T>(x: readonly T[]) => x[0] as T,
      } as unknown as GenContext["rng"],
      seed,
      input: parseBugsInput({ target: "http://127.0.0.1:9", seed, maxCasesPerOperation: maxCases }),
      roles: { privileged: [], unprivileged: [] },
    };
    const op = contract.operations.find((o) => o.key === "POST /orders");
    return pairwiseCases(g, op as NonNullable<typeof op>);
  };

  it("varies body fields together with parameters, deterministically, within the case budget", () => {
    const a = gen(7);
    const b = gen(7);
    const strip = (cs: typeof a) => cs.map((c) => ({ label: c.label, steps: c.steps }));
    expect(strip(a)).toEqual(strip(b));
    expect(a.length).toBeGreaterThan(5);
    expect(a.every((c) => c.steps[0]?.expect === "valid")).toBe(true);
    const kinds = new Set(
      a.map((c) => (c.steps[0]?.request.body as { value: { kind: string } } | undefined)?.value.kind),
    );
    expect(kinds).toEqual(new Set(["standard", "express", "pickup"]));
    const dry = new Set(a.map((c) => JSON.stringify(c.steps[0]?.request.query.dryRun)));
    expect(dry.size).toBe(3); // true, false, absent
    expect(gen(7, 4)).toHaveLength(4);
  });
});
