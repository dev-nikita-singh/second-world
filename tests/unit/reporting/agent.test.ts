import { describe, expect, it } from "vitest";
import type { AgentData, AgentFindingSummary } from "../../../src/engines/agent/engine.js";
import { isAgentData } from "../../../src/engines/reporting/agent.js";
import { renderReport } from "../../../src/engines/reporting/index.js";
import { makeBugsData, makeFinding, makeResult } from "../../fixtures/reports.js";

const summary = (o: Partial<AgentFindingSummary>): AgentFindingSummary => ({
  id: "a1",
  fingerprint: "fp-idem",
  ruleId: "agent/idempotency-key-race",
  operation: "POST /orders",
  technique: "idempotency-concurrent",
  classification: "reproduced-defect",
  severity: "high",
  title: "Concurrent requests with one Idempotency-Key create 2 orders",
  hypothesis: "The key lookup and insert are not atomic",
  message: "2 distinct order ids",
  flaky: false,
  failures: 3,
  replays: 3,
  rate: 1,
  wilson: { lower: 0.439, upper: 1 },
  minimized: true,
  scenario: {} as AgentFindingSummary["scenario"],
  curl: [
    `curl -sS -X POST 'http://127.0.0.1:3000/orders' -H "Authorization: $SW_AUTH_USER" -H 'Idempotency-Key: k1' --data '{}' &`,
    `curl -sS -X POST 'http://127.0.0.1:3000/orders' -H 'Authorization: Bearer alice-token' -H 'Idempotency-Key: k1' --data '{}'`,
  ],
  exchanges: [],
  ...o,
});

function makeAgentData(over: Partial<AgentData> = {}): AgentData {
  return {
    schema: 1,
    planner: "heuristic",
    bandit: "ucb1",
    target: "http://127.0.0.1:3000",
    seed: 42,
    contract: { source: "openapi.yaml", hash: "h", operations: 11 },
    findings: [
      summary({}),
      summary({
        id: "a2",
        fingerprint: "fp-bola",
        ruleId: "bugs/bola",
        operation: "GET /orders/{id}",
        technique: "ownership",
        severity: "critical",
        title: "Other user reads order",
        flaky: true,
        failures: 2,
        replays: 5,
        wilson: { lower: 0.118, upper: 0.769 },
        minimized: false,
        curl: [`curl -sS 'http://127.0.0.1:3000/orders/ord_1' -H "Authorization: $SW_AUTH_OTHER"`],
      }),
      summary({
        id: "a3",
        fingerprint: "fp-slow",
        ruleId: "agent/slow-response",
        classification: "observation",
        severity: "low",
        title: "Slow login",
        technique: "boundary",
        operation: "POST /auth/login",
        flaky: false,
        replays: 0,
        failures: 0,
        curl: [],
      }),
    ],
    coverage: {
      percent: 62.5,
      documented: { observed: 20, total: 32 },
      bits: { status: 20, branch: 7, param: 11, trans: 4 },
    },
    hypotheses: [
      {
        iteration: 1,
        arm: "POST /orders|idempotency-concurrent",
        technique: "idempotency-concurrent",
        operation: "POST /orders",
        source: "heuristic",
        title: "same key x2 concurrently",
        hypothesis: "Concurrent duplicates are created",
        fingerprint: "sc1",
        outcome: "confirmed",
        requests: 12,
        newCoverage: 1,
        failures: ["fp-idem"],
      },
      {
        iteration: 2,
        arm: "GET /orders/{id}|ownership",
        technique: "ownership",
        operation: "GET /orders/{id}",
        source: "heuristic",
        title: "bob reads alice's order",
        hypothesis: "Ownership is not checked",
        fingerprint: "sc2",
        outcome: "flaky",
        requests: 9,
        newCoverage: 0,
        failures: ["fp-bola"],
      },
      {
        iteration: 3,
        arm: "GET /products|boundary",
        technique: "boundary",
        operation: "GET /products",
        source: "heuristic",
        title: "huge page",
        hypothesis: "Large page sizes crash",
        fingerprint: "sc3",
        outcome: "not-reproduced",
        reason: "0/3 replays failed",
        requests: 4,
        newCoverage: 0,
        failures: [],
      },
      {
        iteration: 4,
        arm: "POST /cart/items|lifecycle",
        technique: "lifecycle",
        operation: "POST /cart/items",
        source: "heuristic",
        title: "add after delete",
        hypothesis: "State machine allows it",
        fingerprint: "sc4",
        outcome: "inconclusive",
        reason: "rate limited",
        requests: 2,
        newCoverage: 0,
        failures: [],
      },
      {
        iteration: 5,
        arm: "POST /auth/login|boundary",
        technique: "boundary",
        operation: "POST /auth/login",
        source: "heuristic",
        title: "long password",
        hypothesis: "Slow hashing",
        fingerprint: "sc5",
        outcome: "observation",
        requests: 3,
        newCoverage: 2,
        failures: ["fp-slow"],
      },
    ],
    rejected: [
      {
        source: "history",
        arm: "DELETE /admin|privilege",
        title: "drop all",
        reasons: ["operation not in contract", "destructive without approval"],
      },
      { source: "heuristic", reasons: ["budget exhausted"] },
    ],
    rejectedTotal: 25,
    budget: {
      iterations: { used: 5, max: 150 },
      requests: { used: 30, max: 2000, replays: 11 },
      durationMs: { used: 4200 },
      stopReason: "no-new-info",
    },
    arms: {},
    suggestedTests: [
      {
        fingerprint: "fp-idem",
        ruleId: "agent/idempotency-key-race",
        operation: "POST /orders",
        title: "idempotency race",
        filename: "agent-idempotency-key-race-post-orders.test.ts",
        vitest: Array.from({ length: 20 }, (_, i) =>
          i === 3 ? "const auth = process.env.SW_AUTH_USER;" : `// line ${i}`,
        ).join("\n"),
        config: "regression: [{ /* scenario */ }]",
      },
    ],
    mutationsAllowed: true,
    ...over,
  };
}

const agentFindings = () => [
  makeFinding({
    id: "f1",
    fingerprint: "fp-idem",
    engine: "agent",
    category: "bug",
    ruleId: "agent/idempotency-key-race",
    severity: "high",
    classification: "reproduced-defect",
    title: "Concurrent duplicates",
    affected: ["POST /orders"],
  }),
  makeFinding({
    id: "f2",
    fingerprint: "fp-bola",
    engine: "agent",
    category: "security",
    ruleId: "bugs/bola",
    severity: "critical",
    classification: "reproduced-defect",
    title: "BOLA",
    affected: ["GET /orders/{id}"],
  }),
  makeFinding({
    id: "f3",
    fingerprint: "fp-slow",
    engine: "agent",
    category: "performance",
    ruleId: "agent/slow-response",
    severity: "low",
    classification: "observation",
    title: "Slow login",
    affected: ["POST /auth/login"],
  }),
];
const agentResult = (data = makeAgentData()) =>
  makeResult({ engine: "agent", status: "failed", data, findings: agentFindings() });

describe("agent rendering", () => {
  it("guard", () => {
    expect(isAgentData(makeAgentData())).toBe(true);
    expect(isAgentData(makeBugsData())).toBe(false);
  });

  const s = renderReport([agentResult()], "tty", { color: false });

  it("header: planner, bandit, seed, budget used vs limits, stop reason, coverage", () => {
    expect(s).toMatch(/planner\s+heuristic \(bandit ucb1, seed 42\)/);
    expect(s).toMatch(/iterations\s+5\/150/);
    expect(s).toMatch(/requests\s+30\/2000 \(11 replays\)/);
    expect(s).toMatch(/stop reason\s+no-new-info/);
    expect(s).toMatch(/coverage\s+62\.5% \(20\/32 documented status pairs\)/);
  });

  it("coverage delta vs baseline when provided", () => {
    const d = makeAgentData();
    (d.coverage as { baselinePercent?: number }).baselinePercent = 50;
    const t = renderReport([agentResult(d)], "tty", { color: false });
    expect(t).toContain("+12.5 pts vs baseline 50.0%");
  });

  it("hypotheses tried with every outcome visible", () => {
    expect(s).toContain("Hypotheses tried (5)");
    expect(s).toContain("POST /orders × idempotency-concurrent");
    expect(s).toContain("confirmed 3/3");
    expect(s).toContain("flaky 2/5");
    expect(s).toContain("not reproduced — 0/3 replays failed");
    expect(s).toContain("inconclusive — rate limited");
    expect(s).toMatch(/│ observation\s+│/);
  });

  it("rejected proposals with validator reasons and total", () => {
    expect(s).toContain("Rejected proposals (25; validator reasons)");
    expect(s).toContain("operation not in contract; destructive without approval");
    expect(s).toContain("23 more rejected proposal(s) not shown");
  });

  it("findings with reproductions: placeholders kept, literal tokens scrubbed", () => {
    expect(s).toContain("Agent findings (3)");
    expect(s).toContain("flaky 2/5 (Wilson 95% CI 11.80%–76.90%)");
    expect(s).toContain("Concurrent requests with one Idempotency-Key create 2 orders (minimized)");
    expect(s).toContain("hypothesis: The key lookup and insert are not atomic");
    expect(s).toContain('-H "Authorization: $SW_AUTH_USER"');
    expect(s).toContain("-H 'Authorization: Bearer [REDACTED]'");
    expect(s).not.toContain("alice-token");
  });

  it("suggested tests: table + short preview code block + config snippet", () => {
    expect(s).toContain("Suggested tests");
    expect(s).toContain("agent-idempotency-key-race-post-orders.test.ts");
    expect(s).toContain("const auth = process.env.SW_AUTH_USER;");
    expect(s).toContain("// … 8 more line(s): sw agent --export-tests <dir>");
    expect(s).not.toContain("// line 15");
    expect(s).toContain("agent.regression config snippet");
  });

  it("md / html / json", () => {
    const md = renderReport([agentResult()], "md");
    expect(md).toContain("```ts\n// line 0");
    expect(md).toContain("```sh\ncurl -sS -X POST");
    expect(md).not.toContain("alice-token");
    const html = renderReport([agentResult()], "html");
    expect(html).toContain("<h4>Hypotheses tried (5)</h4>");
    expect(html).not.toMatch(/<script|\s(src|href)\s*=/i);
    expect(html).not.toContain("alice-token");
    expect(JSON.parse(renderReport([agentResult()], "json")).results[0].data.hypotheses).toHaveLength(5);
  });

  it("junit: one case per hypothesis; confirmed defects at/above fail-on fail", () => {
    const xml = renderReport([agentResult()], "junit", { failOn: "high" });
    const names = [...xml.matchAll(/<testcase name="([^"]+)" classname="([^"]+)"/g)].map((m) => m[2]);
    expect(names).toEqual([
      "agent.idempotency-concurrent",
      "agent.ownership",
      "agent.boundary",
      "agent.lifecycle",
      "agent.boundary",
    ]);
    expect(xml).toContain('tests="5" failures="2" errors="0" skipped="1"');
    expect(xml).toContain('<failure message="confirmed 3/3: [high] agent/idempotency-key-race"');
    expect(xml).toContain('<failure message="flaky 2/5: [critical] bugs/bola"');
    const crit = renderReport([agentResult()], "junit", { failOn: "critical" });
    expect(crit).toContain('failures="1"');
  });

  it("sarif: operation as logical location + replay properties", () => {
    const sarif = JSON.parse(renderReport([agentResult()], "sarif"));
    const r = (sarif.runs[0].results as any[]).find((x) => x.ruleId === "agent/idempotency-key-race");
    expect(r.locations[0].logicalLocations[0]).toEqual({
      name: "POST /orders",
      fullyQualifiedName: "POST /orders",
      kind: "resource",
    });
    expect(r.properties).toMatchObject({
      operation: "POST /orders",
      technique: "idempotency-concurrent",
      replay: { failures: 3, replays: 3 },
    });
  });
});
