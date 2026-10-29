/**
 * Heuristic agent vs shop-express (seeded defects): it must confirm seeded defects that a
 * reduced baseline (Bug Hunter with only the contract technique) misses, each with a working
 * replay, and respect the request budget exactly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { type AgentData, runAgent } from "../../../src/engines/agent/index.js";
import { type BugsData, runBugHunt } from "../../../src/engines/bugs/index.js";
import { type RunningExample, startExample } from "../../helpers/examples.js";
import { matchedDefects, SHOP_AUTH, startCountingProxy } from "./helpers.js";

let app: RunningExample;
let baseline: EngineResult<BugsData>;
let agent: EngineResult<AgentData>;

const common = () => ({
  target: app.url,
  openapi: "examples/shop-express/openapi.yaml",
  seed: 42,
  allowMutations: true,
  auth: SHOP_AUTH,
  hooks: { reset: { http: { method: "POST", url: `${app.url}/__test/reset` } } },
});

beforeAll(async () => {
  app = await startExample("shop-express");
  baseline = await runBugHunt({ ...common(), techniques: ["contract"] }, { seed: 42 });
  agent = await runAgent(
    { ...common(), budget: { maxRequests: 800, maxIterations: 150, patience: 40 } },
    { seed: 42 },
  );
}, 55_000);

afterAll(async () => {
  await app?.close();
});

describe("agent vs shop-express", () => {
  it("confirms seeded defects the reduced baseline missed", () => {
    const base = matchedDefects("shop-express", baseline.findings);
    const found = matchedDefects("shop-express", agent.findings);
    const beyond = found.filter((d) => !base.includes(d));
    const d = agent.data as AgentData;
    process.stderr.write(
      `[sw-agent] shop-express baseline=${base.join(",") || "-"} agent=${found.join(",")} beyond=${beyond.join(",")} iterations=${d.budget.iterations.used} requests=${d.budget.requests.used} (replays ${d.budget.requests.replays}) coverage=${d.coverage.percent}% rejected=${d.rejectedTotal} stop=${d.budget.stopReason} ms=${d.budget.durationMs.used.toFixed(0)}\n`,
    );
    for (const f of agent.findings)
      process.stderr.write(
        `  ${f.classification} ${f.severity} ${f.ruleId} ${f.affected[0]} :: ${f.title}\n`,
      );
    expect(beyond.length).toBeGreaterThanOrEqual(1);
    expect(beyond.some((x) => x === "idempotency-ignored" || x === "bola-orders")).toBe(true);
    expect(agent.status).toBe("failed");
  });

  it("every confirmed defect was reproduced on every replay and has a suggested test", () => {
    const d = agent.data as AgentData;
    const confirmed = d.findings.filter((f) => f.classification === "reproduced-defect");
    expect(confirmed.length).toBeGreaterThan(0);
    for (const f of confirmed) {
      expect(f.replays, f.title).toBeGreaterThanOrEqual(3);
      expect(f.failures).toBe(f.replays);
      for (const c of f.curl) expect(c).not.toMatch(/alice-token|bob-token|admin-token/);
    }
    expect(d.suggestedTests.length).toBe(confirmed.length);
    for (const t of d.suggestedTests) expect(t.vitest).not.toMatch(/alice-token|bob-token|admin-token/);
  });

  it("the recorded scenario replays as a pinned regression and reproduces again", async () => {
    const d = agent.data as AgentData;
    const target = d.findings.find(
      (f) =>
        f.classification === "reproduced-defect" &&
        (f.ruleId === "bugs/bola" || f.ruleId === "bugs/idempotency-key-ignored"),
    );
    expect(target).toBeDefined();
    const again = await runAgent(
      {
        ...common(),
        techniques: [],
        regression: [target?.scenario],
        budget: { maxRequests: 100, maxIterations: 5, patience: 5 },
      },
      { seed: 7 },
    );
    const f = again.findings.find((x) => x.fingerprint === target?.fingerprint);
    expect(f?.classification).toBe("reproduced-defect");
  }, 20_000);

  it("respects the request budget exactly (server-side count)", async () => {
    const proxy = await startCountingProxy(app.url);
    try {
      const max = 40;
      const r = await runAgent(
        {
          ...common(),
          target: proxy.url,
          hooks: { reset: { http: { method: "POST", url: `${proxy.url}/__test/reset` } } },
          budget: { maxRequests: max, maxIterations: 1000, patience: 1000 },
        },
        { seed: 42 },
      );
      const d = r.data as AgentData;
      expect(proxy.count()).toBeLessThanOrEqual(max);
      expect(d.budget.requests.used).toBe(proxy.count());
      expect(d.budget.stopReason).toBe("requests");
    } finally {
      await proxy.close();
    }
  }, 20_000);
});
