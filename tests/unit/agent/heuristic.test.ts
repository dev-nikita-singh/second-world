import { describe, expect, it } from "vitest";
import { createRng } from "../../../src/core/rng.js";
import { extractArchHints, extractHistory, scenarioFromBugCase } from "../../../src/engines/agent/context.js";
import { CoverageTracker } from "../../../src/engines/agent/coverage.js";
import { HeuristicPlanner } from "../../../src/engines/agent/planner/heuristic.js";
import type { Arm, PlanState } from "../../../src/engines/agent/planner/types.js";
import { validateProposal } from "../../../src/engines/agent/safety.js";
import type { ScenarioInput } from "../../../src/engines/agent/scenario.js";
import { AGENT_TECHNIQUES } from "../../../src/engines/agent/schema.js";
import { Dictionary } from "../../../src/engines/bugs/dictionary.js";
import type { GenContext } from "../../../src/engines/bugs/generate.js";
import { BugsInputSchema } from "../../../src/engines/bugs/schema.js";
import { miniContract, opsOf, policy } from "./fixtures.js";

function gen(): GenContext {
  const contract = miniContract();
  const input = BugsInputSchema.parse({
    target: "http://127.0.0.1:1",
    auth: {
      roles: {
        user: { type: "bearer", token: "t1" },
        other: { type: "bearer", token: "t2" },
        admin: { type: "bearer", token: "t3" },
      },
    },
  });
  return {
    contract,
    dict: new Dictionary({}),
    rng: createRng(1),
    seed: 1,
    input,
    roles: {
      default: "user",
      owner: "user",
      attacker: "other",
      privileged: ["admin"],
      unprivileged: ["user", "other"],
    },
  };
}

function planner(extra: Partial<ConstructorParameters<typeof HeuristicPlanner>[0]> = {}): HeuristicPlanner {
  const g = gen();
  return new HeuristicPlanner({
    g,
    ops: g.contract.operations,
    techniques: AGENT_TECHNIQUES,
    maxCopies: 10,
    slowMs: 500,
    ...extra,
  });
}

const state = (cov = new CoverageTracker()): PlanState => ({
  coverage: cov,
  iteration: 0,
  confirmed: new Set(),
});
const arm = (p: HeuristicPlanner, key: string): Arm => {
  const a = p.arms().find((x) => x.key === key);
  if (!a)
    throw new Error(
      `no arm ${key}: ${p
        .arms()
        .map((x) => x.key)
        .join(", ")}`,
    );
  return a;
};

describe("heuristic planner", () => {
  it("lists operation × technique arms that apply", () => {
    const keys = planner()
      .arms()
      .map((a) => a.key);
    expect(keys).toContain("idempotency POST /orders");
    expect(keys).toContain("idempotency-concurrent POST /orders");
    expect(keys).toContain("boundary GET /items");
    expect(keys).toContain("boundary POST /orders");
    expect(keys).toContain("ownership GET /orders/{id}");
    expect(keys).toContain("lifecycle GET /orders/{id}");
    expect(keys).toContain("privilege DELETE /items/{id}");
    expect(keys).toContain("status-gap POST /orders");
    expect(keys).toContain("param-gap GET /items");
    expect(keys.some((k) => k.startsWith("history"))).toBe(false);
  });

  it("respects the enabled techniques", () => {
    const keys = planner({ techniques: ["boundary"] })
      .arms()
      .map((a) => a.technique);
    expect(new Set(keys)).toEqual(new Set(["boundary"]));
  });

  it("every proposal it makes passes the safety validator (with permissions)", async () => {
    const p = planner();
    let n = 0;
    for (const a of p.arms()) {
      for (const raw of await p.propose(a, state())) {
        n++;
        const r = validateProposal(raw, policy({ destructiveAllowed: true }));
        expect(r.ok ? [] : r.reasons, `${a.key}: ${JSON.stringify(raw)}`).toEqual([]);
      }
    }
    expect(n).toBeGreaterThan(15);
  });

  it("boundary pairs on numeric query params and nested body fields", async () => {
    const p = planner();
    const q = (await p.propose(arm(p, "boundary GET /items"), state())) as ScenarioInput[];
    expect(q.map((s) => s.steps[0]?.query?.limit)).toEqual([0, 1, 100, 101]);
    // out-of-range values must be rejected (4xx), in-range values only must not 5xx
    expect(q[0]?.assertions.map((a) => a.kind)).toEqual(["no-5xx", "status-class"]);
    expect(q[1]?.assertions.map((a) => a.kind)).toEqual(["no-5xx"]);
    const b = (await p.propose(arm(p, "boundary POST /orders"), state())) as ScenarioInput[];
    expect(b.map((s) => (s.steps[0]?.body as { qty: number } | undefined)?.qty)).toEqual([0, 1, 100, 101]);
    expect(b[0]?.assertions[0]).toMatchObject({ kind: "no-5xx", rule: "bugs/server-error-on-boundary" });
  });

  it("duplicate-submit check reuses one Idempotency-Key", async () => {
    const p = planner();
    const [s] = (await p.propose(arm(p, "idempotency POST /orders"), state())) as ScenarioInput[];
    expect(s?.steps).toHaveLength(2);
    expect(s?.steps[0]?.headers?.["Idempotency-Key"]).toBe("{{$nonce}}");
    expect(s?.steps[1]?.headers?.["Idempotency-Key"]).toBe("{{$nonce}}");
    expect(s?.assertions[0]).toMatchObject({ kind: "same-json", steps: [0, 1], pointer: "/id" });
    const [c] = (await p.propose(arm(p, "idempotency-concurrent POST /orders"), state())) as ScenarioInput[];
    expect(c?.parallel?.copies).toBe(3);
    expect(c?.assertions[0]).toMatchObject({ kind: "copies-agree", rule: "agent/idempotency-key-race" });
  });

  it("cross-account check: owner creates and reads, other account reads", async () => {
    const p = planner();
    const [s] = (await p.propose(arm(p, "ownership GET /orders/{id}"), state())) as ScenarioInput[];
    expect(s?.setup?.map((x) => x.role)).toEqual(["user", "user"]);
    expect(s?.setup?.[0]?.extract).toEqual({ rid: "/id" });
    expect(s?.steps[0]).toMatchObject({
      operation: "GET /orders/{id}",
      role: "other",
      pathParams: { id: "{{rid}}" },
    });
    expect(s?.assertions).toEqual([{ kind: "status-class", step: 0, class: "not-2xx", rule: "bugs/bola" }]);
  });

  it("no cross-account arm without two configured ordinary accounts", () => {
    const g = gen();
    g.roles = { default: "user", owner: "user", privileged: [], unprivileged: ["user"] };
    const p = new HeuristicPlanner({
      g,
      ops: g.contract.operations,
      techniques: AGENT_TECHNIQUES,
      maxCopies: 10,
      slowMs: 1,
    });
    expect(p.arms().some((a) => a.technique === "ownership")).toBe(false);
  });

  it("status gaps disappear once the status was observed", async () => {
    const p = planner();
    const cov = new CoverageTracker();
    const a = arm(p, "status-gap POST /orders");
    const before = (await p.propose(a, state(cov))) as ScenarioInput[];
    expect(before.map((s) => s.title)).toEqual([
      "Anonymous call to POST /orders",
      "Missing required input on POST /orders",
    ]);
    cov.mark("status", "POST /orders", "401");
    cov.mark("status", "POST /orders", "400");
    expect(await p.propose(a, state(cov))).toEqual([]);
  });

  it("param gaps propose only unexercised optional params", async () => {
    const p = planner();
    const cov = new CoverageTracker();
    cov.mark("param", "GET /items", "limit");
    const out = (await p.propose(arm(p, "param-gap GET /items"), state(cov))) as ScenarioInput[];
    expect(out.every((s) => s.steps[0]?.query?.q !== undefined)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });

  it("architecture hints: ARCH005 → largest page size with a time bound", async () => {
    const p = planner({ hints: [{ ruleId: "ARCH005", title: "query in loop", operations: [] }] });
    const [s] = (await p.propose(arm(p, "arch-risk GET /items"), state())) as ScenarioInput[];
    expect(s?.steps[0]?.query?.limit).toBe(100);
    expect(s?.assertions[0]).toMatchObject({ kind: "max-duration", ms: 500, rule: "agent/slow-response" });
  });

  it("history items become re-check arms", async () => {
    const sc: ScenarioInput = {
      title: "x",
      hypothesis: "y",
      steps: [{ operation: "GET /items" }],
      assertions: [{ kind: "no-5xx" }],
      expectedClassification: "defect",
    };
    const p = planner({
      history: [
        {
          ruleId: "bugs/server-error",
          operation: "GET /items",
          source: "bugs",
          fingerprint: "f",
          scenario: sc,
        },
      ],
    });
    expect(await p.propose(arm(p, "history GET /items"), state())).toEqual([sc]);
  });
});

describe("context extraction", () => {
  const ops = opsOf(miniContract());

  it("converts a recorded cross-account case into setup + denied step", () => {
    const tpl = (operation: string, role: string, extra = {}) => ({
      operation,
      method: operation.split(" ")[0] as string,
      path: operation.split(" ")[1] as string,
      pathParams: {},
      query: {},
      headers: {},
      body: { kind: "none" as const },
      role,
      ...extra,
    });
    const sc = scenarioFromBugCase(
      {
        steps: [
          {
            request: tpl("POST /orders", "user", { body: { kind: "json", value: { qty: 1 } } }),
            extract: { rid: "/id" },
            expect: "valid",
          },
          { request: tpl("GET /orders/{id}", "other", { pathParams: { id: "{{rid}}" } }), expect: "none" },
        ],
        check: { kind: "denied", step: 1, rule: "bugs/bola", detail: "" },
      },
      "bugs/bola",
      "GET /orders/{id}",
    );
    expect(sc?.setup).toHaveLength(1);
    expect(sc?.steps[0]?.role).toBe("other");
    expect(sc?.assertions[0]).toMatchObject({ kind: "status-class", class: "not-2xx", rule: "bugs/bola" });
    expect(validateProposal(sc, policy()).ok).toBe(true);
  });

  it("extracts reproduced defects from earlier bugs results only", () => {
    const step = {
      request: {
        operation: "GET /items",
        method: "GET",
        path: "/items",
        pathParams: {},
        query: { limit: 0 },
        headers: {},
        body: { kind: "none" },
      },
      expect: "invalid",
    };
    const results = [
      {
        engine: "bugs",
        findings: [
          {
            classification: "reproduced-defect",
            fingerprint: "a",
            ruleId: "bugs/server-error-on-boundary",
            affected: ["GET /items"],
          },
          {
            classification: "observation",
            fingerprint: "b",
            ruleId: "bugs/server-error",
            affected: ["GET /items"],
          },
        ],
        data: {
          reproductions: {
            a: { case: { steps: [step], check: { kind: "conformance" } } },
            b: { case: { steps: [step], check: { kind: "conformance" } } },
          },
        },
      },
    ];
    const h = extractHistory(results, ops);
    expect(h).toHaveLength(1);
    expect(h[0]?.scenario.assertions.at(-1)).toMatchObject({
      kind: "no-5xx",
      rule: "bugs/server-error-on-boundary",
    });
  });

  it("maps architecture findings to operations by route", () => {
    const hints = extractArchHints(
      [
        {
          engine: "architecture",
          findings: [
            { ruleId: "ARCH007", title: "GET /orders/:id has no auth", affected: ["GET /orders/:id"] },
          ],
        },
        { engine: "bugs", findings: [{ ruleId: "ARCH001" }] },
      ],
      ops,
    );
    expect(hints).toEqual([
      { ruleId: "ARCH007", title: "GET /orders/:id has no auth", operations: ["GET /orders/{id}"] },
    ]);
  });
});
