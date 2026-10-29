/**
 * Heuristic agent vs shop-fastify: the app honours Idempotency-Key, checks order ownership,
 * decrements stock atomically and validates qty (expected-findings.json "correctByDesign").
 * None of these behaviours may be reported as defects.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { type AgentData, runAgent } from "../../../src/engines/agent/index.js";
import { type RunningExample, startExample } from "../../helpers/examples.js";
import { matchedDefects, SHOP_AUTH } from "./helpers.js";

let app: RunningExample;
let agent: EngineResult<AgentData>;

beforeAll(async () => {
  app = await startExample("shop-fastify");
  agent = await runAgent(
    {
      target: app.url,
      openapi: "examples/shop-fastify/openapi.yaml",
      seed: 42,
      allowMutations: true,
      // test environment with a reset hook: allow the privilege check on DELETE /products/{id}
      allowDestructive: true,
      auth: SHOP_AUTH,
      hooks: { reset: { http: { method: "POST", url: `${app.url}/__test/reset` } } },
      // GET /products/search is a seeded slow full scan (~0.5 s per call): keep it out of the loop.
      operations: { include: [], exclude: ["GET /products/search"] },
      budget: { maxRequests: 800, maxIterations: 150, patience: 40 },
    },
    { seed: 42 },
  );
}, 55_000);

afterAll(async () => {
  await app?.close();
});

describe("agent vs shop-fastify (correct by design)", () => {
  it("does not report correct-by-design behaviours", () => {
    const d = agent.data as AgentData;
    const defects = agent.findings.filter((f) => f.classification === "reproduced-defect");
    process.stderr.write(
      `[sw-agent] shop-fastify matched=${matchedDefects("shop-fastify", agent.findings).join(",") || "-"} defects=${defects.length} iterations=${d.budget.iterations.used} requests=${d.budget.requests.used} coverage=${d.coverage.percent}% rejected=${d.rejectedTotal} stop=${d.budget.stopReason} ms=${d.budget.durationMs.used.toFixed(0)}\n`,
    );
    for (const f of agent.findings)
      process.stderr.write(
        `  ${f.classification} ${f.severity} ${f.ruleId} ${f.affected[0]} :: ${f.title}\n`,
      );
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "examples", "shop-fastify", "expected-findings.json"), "utf8"),
    ) as {
      correctByDesign: { id: string; endpoint: string }[];
    };
    expect(raw.correctByDesign.length).toBeGreaterThan(0);
    const forbidden: Record<string, string[]> = {
      "idempotency-honoured": ["bugs/idempotency-key-ignored"],
      "orders-ownership-checked": ["bugs/bola"],
      "stock-atomic": ["bugs/race-lost-update"],
      "order-qty-validated": [
        "bugs/server-error-on-boundary",
        "bugs/server-error-on-invalid-input",
        "bugs/server-error",
      ],
    };
    for (const c of raw.correctByDesign) {
      const rules = forbidden[c.id] ?? [];
      const hit = defects.filter((f) => f.affected[0] === c.endpoint && rules.includes(f.ruleId ?? ""));
      expect(
        hit.map((f) => f.title),
        c.id,
      ).toEqual([]);
    }
  });

  it("actually exercised the correct-by-design areas", () => {
    const d = agent.data as AgentData;
    const tried = new Set(d.hypotheses.map((h) => `${h.technique} ${h.operation}`));
    expect(tried.has("idempotency POST /orders")).toBe(true);
    expect(tried.has("ownership GET /orders/{id}")).toBe(true);
    expect(tried.has("boundary POST /orders")).toBe(true);
    expect(d.budget.requests.used).toBeLessThanOrEqual(800);
    // seeded Bug Hunter defects are still found next to the correct-by-design areas
    expect(matchedDefects("shop-fastify", agent.findings)).toEqual(
      expect.arrayContaining(["boundary-500-limit", "schema-drift-created-at"]),
    );
  });
});
