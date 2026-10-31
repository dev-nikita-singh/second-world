/**
 * Race finding attribution (wave 7b, sw-agent8): when a mixed concurrency test's main operation is
 * a read (burst of GETs) and the writes come from the `mix`, the bugs/race-lost-update finding
 * belongs to the mutating operation (as on conduit-api: GET article burst + POST favorite mix →
 * the lost update is in POST favorite). shop-express has the planted stock race in POST /orders.
 * docs/03-engines/api-bug-hunter.md (concurrency).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import {
  type BugsData,
  type BugsInputLoose,
  replayFinding,
  runBugHunt,
} from "../../../src/engines/bugs/index.js";
import { type RunningExample, startExample } from "../../helpers/examples.js";
import { SHOP_AUTH } from "./helpers.js";

let app: RunningExample;
let result: EngineResult<BugsData>;
let input: BugsInputLoose;

const read = {
  operation: "GET /products/{id}",
  pathParams: { id: 1 },
  as: "read" as const,
  pointer: "/stock",
};
const order = {
  operation: "POST /orders",
  role: "user",
  body: { items: [{ productId: 1, qty: 1 }] },
  as: "take" as const,
};

beforeAll(async () => {
  app = await startExample("shop-express");
  input = {
    target: app.url,
    openapi: "examples/shop-express/openapi.yaml",
    seed: 42,
    techniques: ["concurrency"],
    allowMutations: true,
    auth: SHOP_AUTH,
    hooks: { reset: { http: { method: "POST", url: `${app.url}/__test/reset` } } },
    concurrency: [
      {
        name: "stock: reads around concurrent orders",
        ...read,
        burst: 2,
        mix: [
          { ...read, phase: "before" },
          { ...order, count: 3 },
          { ...read, phase: "after" },
        ],
        invariant: { kind: "linearizable", model: "stock" },
      },
    ],
  };
  result = await runBugHunt(input, { seed: 42 });
}, 90_000);

afterAll(async () => {
  await app?.close();
});

describe("race finding attribution", () => {
  it("a read-burst test with mutating mix ops reports the lost update on the mutating operation", () => {
    const races = result.findings.filter((f) => f.ruleId === "bugs/race-lost-update");
    for (const f of result.findings)
      process.stderr.write(`  ${f.classification} ${f.ruleId} ${f.affected[0]} :: ${f.title}\n`);
    expect(races.length).toBe(1);
    expect(races[0]?.classification).toBe("reproduced-defect");
    expect(races[0]?.affected).toEqual(["POST /orders"]);
  });

  it("sw replay still reproduces the re-attributed finding", async () => {
    const f = result.findings.find((x) => x.ruleId === "bugs/race-lost-update");
    const r = await replayFinding(
      input,
      { finding: f as NonNullable<typeof f>, data: result.data as BugsData },
      { seed: 42 },
      { runs: 3 },
    );
    expect(r.classification).toBe("reproduced-defect");
  }, 60_000);
});
