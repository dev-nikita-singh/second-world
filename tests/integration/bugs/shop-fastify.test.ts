import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/events.js";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { type BugsData, type BugsInputLoose, runBugHunt } from "../../../src/engines/bugs/index.js";
import { type RunningExample, startExample } from "../../helpers/examples.js";
import { score } from "./ground-truth.js";

let app: RunningExample;
let result: EngineResult<BugsData>;
let input: BugsInputLoose;

beforeAll(async () => {
  app = await startExample("shop-fastify");
  input = {
    target: app.url,
    openapi: "examples/shop-fastify/openapi.yaml",
    seed: 42,
    // /products/search is the seeded slow full scan (~0.5 s per call): keep property runs low
    propertyRuns: 8,
    allowMutations: true,
    auth: {
      roles: {
        user: { type: "bearer", token: "alice-token" },
        other: { type: "bearer", token: "bob-token" },
        admin: { type: "bearer", token: "admin-token" },
      },
    },
    hooks: { reset: { http: { method: "POST", url: `${app.url}/__test/reset` } } },
    concurrency: [
      {
        name: "last item sold once",
        operation: "POST /orders",
        burst: 5,
        role: "user",
        body: { productId: 40, qty: 1 },
        invariant: { kind: "linearizable", model: "stock", initial: 1 },
      },
    ],
  };
  const events = createEventBus();
  events.on("bugs.technique", (p) =>
    process.stderr.write(`[sw-bugs] ${JSON.stringify(p)}
`),
  );
  result = await runBugHunt(input, { seed: 42, events });
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe("Bug Hunter vs shop-fastify (seeded defects)", () => {
  it("reproduces every seeded bugs defect with full precision", () => {
    const s = score("shop-fastify", result.findings);
    // eslint-disable-next-line no-console
    process.stderr.write(
      `[sw-bugs] shop-fastify recall=${s.recall.toFixed(2)} precision=${s.precision.toFixed(2)} matched=${s.matched.join(",")} missed=${s.missed.join(",")} fp=${JSON.stringify(s.falsePositives)} requests=${result.data?.requests.sent} ms=${result.data?.durationMs.toFixed(0)}\n`,
    );
    for (const f of result.findings)
      process.stderr.write(
        `  ${f.classification} ${f.severity} ${f.ruleId} ${f.affected[0]} :: ${f.title} x${f.occurrences}\n`,
      );
    expect(s.missed).toEqual([]);
    expect(s.falsePositives).toEqual([]);
    expect(result.status).toBe("failed");
  });
});
