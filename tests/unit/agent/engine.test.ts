import { describe, expect, it } from "vitest";
import type { Planner } from "../../../src/engines/agent/index.js";
import { runAgent } from "../../../src/engines/agent/index.js";
import type { ScenarioInput } from "../../../src/engines/agent/scenario.js";
import { BASE_INPUT, MiniShop, mockOpenSession } from "./mock-session.js";

const readItem = (id: number): ScenarioInput => ({
  title: `item ${id}`,
  hypothesis: "reading an item works",
  steps: [{ operation: "GET /items/{id}", pathParams: { id } }],
  assertions: [{ kind: "no-5xx" }],
  expectedClassification: "defect",
});

function fixedPlanner(proposals: unknown[]): Planner {
  return {
    kind: "heuristic",
    arms: () => [{ key: "param-gap GET /items/{id}", technique: "param-gap", operation: "GET /items/{id}" }],
    propose: async () => proposals,
  };
}

describe("agent engine (mock session)", () => {
  it("confirms the seeded defects with replays and emits suggested tests", async () => {
    const app = new MiniShop(false);
    const r = await runAgent(
      { ...BASE_INPUT, budget: { maxRequests: 400, maxIterations: 80, patience: 40 } },
      { seed: 5 },
      { openSession: mockOpenSession(app) },
    );
    const d = r.data;
    if (!d) throw new Error("no data");
    const defects = r.findings
      .filter((f) => f.classification === "reproduced-defect")
      .map((f) => `${f.ruleId} ${f.affected[0]}`);
    expect(defects).toContain("bugs/idempotency-key-ignored POST /orders");
    expect(defects).toContain("bugs/bola GET /orders/{id}");
    expect(defects).toContain("bugs/server-error-on-boundary GET /items");
    expect(r.status).toBe("failed");
    for (const f of d.findings.filter((x) => x.classification === "reproduced-defect")) {
      expect(f.replays).toBe(3);
      expect(f.failures).toBe(3);
    }
    expect(d.suggestedTests.length).toBe(defects.length);
    expect(d.budget.requests.used).toBeLessThanOrEqual(400);
    expect(d.budget.requests.used).toBe(app.requests);
    expect(d.coverage.percent).toBeGreaterThan(50);
    expect(d.hypotheses.some((h) => h.outcome === "confirmed")).toBe(true);
    expect(d.hypotheses.some((h) => h.outcome === "passed")).toBe(true);
    // destructive DELETE without approval → rejected with a reason
    expect(d.rejected.some((x) => x.reasons.some((y) => /requires approval/.test(y)))).toBe(true);
    // curl never contains a credential
    for (const f of d.findings) for (const c of f.curl) expect(c).not.toMatch(/\bt[123]\b/);
    for (const t of d.suggestedTests) expect(t.vitest).not.toMatch(/"t[123]"/);
  });

  it("reports no defects on the correct app", async () => {
    const r = await runAgent(
      { ...BASE_INPUT, budget: { maxRequests: 400, maxIterations: 80, patience: 40 } },
      { seed: 5 },
      { openSession: mockOpenSession(new MiniShop(true)) },
    );
    expect(r.findings.filter((f) => f.classification === "reproduced-defect")).toEqual([]);
    expect(r.status).toBe("passed");
  });

  it("is deterministic for a seed", async () => {
    const run = async () => {
      const r = await runAgent(
        { ...BASE_INPUT, budget: { maxRequests: 120, maxIterations: 30, patience: 40 } },
        { seed: 5 },
        { openSession: mockOpenSession(new MiniShop(false)) },
      );
      return r.data?.hypotheses.map((h) => `${h.arm}|${h.title}|${h.outcome}`);
    };
    expect(await run()).toEqual(await run());
  });

  it("never exceeds the request budget", async () => {
    for (const max of [1, 5, 13, 37]) {
      const app = new MiniShop(false);
      const r = await runAgent(
        { ...BASE_INPUT, budget: { maxRequests: max, maxIterations: 500, patience: 500 } },
        { seed: 5 },
        { openSession: mockOpenSession(app) },
      );
      expect(app.requests, `max ${max}`).toBeLessThanOrEqual(max);
      expect(r.data?.budget.requests.used).toBe(app.requests);
      expect(r.data?.budget.stopReason).toBe("requests");
    }
  });

  it("stops on the iteration budget", async () => {
    const r = await runAgent(
      { ...BASE_INPUT, budget: { maxRequests: 1000, maxIterations: 4, patience: 100 } },
      { seed: 5 },
      { openSession: mockOpenSession(new MiniShop(true)) },
    );
    expect(r.data?.budget.iterations.used).toBe(4);
    expect(r.data?.budget.stopReason).toBe("iterations");
  });

  it("stops after k rounds without new information", async () => {
    const proposals = Array.from({ length: 10 }, (_, i) => readItem(i + 1));
    const r = await runAgent(
      { ...BASE_INPUT, budget: { maxRequests: 1000, maxIterations: 100, patience: 3 } },
      { seed: 5 },
      { openSession: mockOpenSession(new MiniShop(true)), planner: () => fixedPlanner(proposals) },
    );
    // first scenario yields new coverage, the next 3 do not
    expect(r.data?.budget.iterations.used).toBe(4);
    expect(r.data?.budget.stopReason).toBe("no-new-info");
  });

  it("honours cancellation mid-run", async () => {
    const ac = new AbortController();
    const { createEventBus } = await import("../../../src/core/events.js");
    const events = createEventBus();
    events.on("agent.iteration", (p) => {
      if ((p as { iteration: number }).iteration >= 3) ac.abort();
    });
    const r = await runAgent(
      { ...BASE_INPUT, budget: { maxRequests: 1000, maxIterations: 100, patience: 100 } },
      { seed: 5, signal: ac.signal, events },
      { openSession: mockOpenSession(new MiniShop(true)) },
    );
    expect(r.status).toBe("cancelled");
    expect(r.data?.budget.stopReason).toBe("cancelled");
    expect(r.data?.budget.iterations.used).toBe(3);
  });

  it("rejects and audits policy-violating proposals, skips duplicates", async () => {
    const events: { action: string }[] = [];
    const bad = [
      { ...readItem(1), steps: [{ operation: "GET /nope" }] },
      { ...readItem(1), steps: [{ operation: "GET /items/{id}", pathParams: { id: "../admin" } }] },
      { ...readItem(1), steps: [{ operation: "GET /items", query: { q: "http://example.com/" } }] },
      readItem(2),
      readItem(2),
    ];
    const { createEngineContext } = await import("../../../src/core/context.js");
    const base = createEngineContext({ seed: 5 });
    const safety = {
      ...base.safety,
      audit: (e: { action: string }) => events.push(e),
      reserve: base.safety.reserve.bind(base.safety),
    };
    const r = await runAgent(
      BASE_INPUT,
      { seed: 5, safety: safety as typeof base.safety },
      { openSession: mockOpenSession(new MiniShop(true)), planner: () => fixedPlanner(bad) },
    );
    expect(r.data?.rejectedTotal).toBe(3);
    expect(r.data?.rejected.map((x) => x.reasons[0])).toEqual([
      expect.stringMatching(/unknown operation/),
      expect.stringMatching(/path traversal/),
      expect.stringMatching(/foreign host/),
    ]);
    expect(events.filter((e) => e.action === "agent.scenario.rejected")).toHaveLength(3);
    expect(r.data?.hypotheses).toHaveLength(1);
    expect(r.data?.budget.stopReason).toBe("arms-exhausted");
  });

  it("blocks mutating proposals when mutations are not allowed", async () => {
    const app = new MiniShop(false);
    const r = await runAgent(
      { ...BASE_INPUT, budget: { maxRequests: 300, maxIterations: 60, patience: 60 } },
      { seed: 5 },
      { openSession: mockOpenSession(app, { mutationsAllowed: false }) },
    );
    expect(
      r.data?.hypotheses.every((h) => !h.operation.startsWith("POST") && !h.operation.startsWith("DELETE")),
    ).toBe(true);
    expect(r.data?.rejected.some((x) => x.reasons.some((y) => /not permitted/.test(y)))).toBe(true);
    expect(r.findings.map((f) => f.ruleId)).toContain("bugs/server-error-on-boundary");
  });

  it("runs pinned regression scenarios first", async () => {
    const reg: ScenarioInput = {
      title: "pinned",
      hypothesis: "limit=0 must not 5xx",
      steps: [{ operation: "GET /items", query: { limit: 0 } }],
      assertions: [{ kind: "no-5xx", rule: "bugs/server-error-on-boundary" }],
      expectedClassification: "defect",
    };
    const r = await runAgent(
      { ...BASE_INPUT, regression: [reg], budget: { maxRequests: 50, maxIterations: 1, patience: 10 } },
      { seed: 5 },
      { openSession: mockOpenSession(new MiniShop(false)) },
    );
    expect(r.data?.hypotheses[0]?.technique).toBe("regression");
    expect(r.findings[0]?.classification).toBe("reproduced-defect");
  });

  it("minimises scenarios with irrelevant setup steps (ddmin)", async () => {
    const noisy: ScenarioInput = {
      title: "noisy",
      hypothesis: "limit=0 fails regardless of earlier reads",
      setup: [
        { operation: "GET /items/{id}", pathParams: { id: 1 } },
        { operation: "GET /items/{id}", pathParams: { id: 2 } },
        { operation: "GET /items", query: { limit: 5 } },
      ],
      steps: [{ operation: "GET /items", query: { limit: 0 } }],
      assertions: [{ kind: "no-5xx", rule: "bugs/server-error-on-boundary" }],
      expectedClassification: "defect",
    };
    const r = await runAgent(
      BASE_INPUT,
      { seed: 5 },
      { openSession: mockOpenSession(new MiniShop(false)), planner: () => fixedPlanner([noisy]) },
    );
    const f = r.data?.findings[0];
    expect(f?.minimized).toBe(true);
    expect(f?.scenario.setup).toEqual([]);
    expect(f?.scenario.steps).toHaveLength(1);
  });
});
