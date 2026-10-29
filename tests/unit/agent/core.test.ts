import { describe, expect, it } from "vitest";
import { createRng } from "../../../src/core/rng.js";
import { sampleBeta, ThompsonBandit, Ucb1Bandit } from "../../../src/engines/agent/bandit.js";
import {
  BloomFilter,
  CoverageTracker,
  NoveltySet,
  responseShape,
} from "../../../src/engines/agent/coverage.js";
import { isDestructive, preflightRaw, validateProposal } from "../../../src/engines/agent/safety.js";
import {
  canonicalJson,
  parseScenario,
  requestCount,
  type Scenario,
  scenarioFingerprint,
} from "../../../src/engines/agent/scenario.js";
import { idempotencyScenario, miniContract, policy, readScenario } from "./fixtures.js";

describe("ScenarioSchema", () => {
  it("accepts a minimal scenario and fills defaults", () => {
    const r = parseScenario(readScenario());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scenario.setup).toEqual([]);
  });

  it("rejects unknown top-level fields", () => {
    const r = parseScenario({ ...readScenario(), url: "http://127.0.0.1/x" });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown step fields (no code/url/command)", () => {
    for (const extra of [{ code: "x" }, { url: "/x" }, { command: "ls" }, { host: "a" }]) {
      const s = readScenario({ steps: [{ operation: "GET /items", ...extra } as never] });
      expect(parseScenario(s).ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it("rejects unknown assertion kinds and extra assertion fields", () => {
    expect(parseScenario(readScenario({ assertions: [{ kind: "custom" } as never] })).ok).toBe(false);
    expect(parseScenario(readScenario({ assertions: [{ kind: "no-5xx", extra: 1 } as never] })).ok).toBe(
      false,
    );
  });

  it("requires at least one explicit assertion and one step", () => {
    expect(parseScenario(readScenario({ assertions: [] })).ok).toBe(false);
    expect(parseScenario(readScenario({ steps: [] })).ok).toBe(false);
  });

  it("checks assertion step indices and parallel pairing", () => {
    expect(parseScenario(readScenario({ assertions: [{ kind: "status", step: 3, oneOf: [200] }] })).ok).toBe(
      false,
    );
    expect(
      parseScenario(readScenario({ assertions: [{ kind: "max-success", step: 0, max: 1 }] })).ok,
      "max-success without parallel",
    ).toBe(false);
    expect(
      parseScenario(
        readScenario({ parallel: { copies: 5 }, assertions: [{ kind: "max-success", step: 0, max: 1 }] }),
      ).ok,
    ).toBe(true);
  });

  it("counts requests including parallel copies", () => {
    const r = parseScenario(readScenario({ parallel: { copies: 5 } }));
    expect(r.ok && requestCount(r.scenario)).toBe(5);
    const r2 = parseScenario(idempotencyScenario());
    expect(r2.ok && requestCount(r2.scenario)).toBe(2);
  });

  it("fingerprint ignores title/hypothesis and key order", () => {
    const a = parseScenario(readScenario()) as { ok: true; scenario: Scenario };
    const b = parseScenario(readScenario({ title: "other", hypothesis: "other" })) as {
      ok: true;
      scenario: Scenario;
    };
    expect(scenarioFingerprint(a.scenario)).toBe(scenarioFingerprint(b.scenario));
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
    const c = parseScenario(readScenario({ steps: [{ operation: "GET /items", query: { limit: 11 } }] })) as {
      ok: true;
      scenario: Scenario;
    };
    expect(scenarioFingerprint(c.scenario)).not.toBe(scenarioFingerprint(a.scenario));
  });
});

describe("safety validator", () => {
  const reasons = (raw: unknown, over = {}): string[] => {
    const r = validateProposal(raw, policy(over));
    return r.ok ? [] : r.reasons;
  };

  it("accepts valid read and duplicate-submit scenarios", () => {
    expect(reasons(readScenario())).toEqual([]);
    expect(reasons(idempotencyScenario())).toEqual([]);
  });

  it("rejects an operation that is not in the contract", () => {
    const r = reasons(readScenario({ steps: [{ operation: "GET /secret" }] }));
    expect(r.join()).toMatch(/unknown operation/);
  });

  it("rejects `..` and separators in path parameters", () => {
    for (const id of ["../admin", "a/b", "%2e%2e", "a\\b", ".."]) {
      const r = reasons(readScenario({ steps: [{ operation: "GET /items/{id}", pathParams: { id } }] }));
      expect(r.join(), id).toMatch(/path traversal/);
    }
  });

  it("rejects path params that are not part of the operation, or missing ones", () => {
    expect(
      reasons(
        readScenario({ steps: [{ operation: "GET /items/{id}", pathParams: { id: 1, x: 2 } }] }),
      ).join(),
    ).toMatch(/not part of/);
    expect(reasons(readScenario({ steps: [{ operation: "GET /items/{id}" }] })).join()).toMatch(
      /missing path parameter/,
    );
  });

  it("rejects URLs to hosts outside the allow-list", () => {
    const r = reasons(
      readScenario({ steps: [{ operation: "GET /items", query: { q: "http://example.com/x" } }] }),
    );
    expect(r.join()).toMatch(/foreign host "example.com"/);
    expect(
      reasons(readScenario({ steps: [{ operation: "GET /items", query: { q: "http://127.0.0.1:9/x" } }] })),
    ).toEqual([]);
    expect(
      reasons(readScenario({ steps: [{ operation: "GET /items", query: { q: "//example.com/x" } }] })).join(),
    ).toMatch(/protocol-relative/);
  });

  it("rejects roles that are not configured test accounts", () => {
    expect(reasons(readScenario({ steps: [{ operation: "GET /items", role: "root" }] })).join()).toMatch(
      /not a configured test account/,
    );
    expect(reasons(readScenario({ steps: [{ operation: "GET /items", role: null }] }))).toEqual([]);
    expect(reasons(readScenario({ steps: [{ operation: "GET /items", role: "$invalid" }] }))).toEqual([]);
  });

  it("rejects credential/routing headers and control characters", () => {
    for (const h of ["Authorization", "Cookie", "Host", "X-Forwarded-For"]) {
      const r = reasons(readScenario({ steps: [{ operation: "GET /items", headers: { [h]: "v" } }] }));
      expect(r.join(), h).toMatch(/may not be set/);
    }
    expect(
      reasons(readScenario({ steps: [{ operation: "GET /items", headers: { "X-Note": "a\r\nb" } }] })).join(),
    ).toMatch(/control characters/);
  });

  it("rejects mutations without permission", () => {
    const r = reasons(idempotencyScenario(), { mutationsAllowed: false });
    expect(r.join()).toMatch(/not permitted/);
  });

  it("rejects destructive operations without approval, accepts them with approval", () => {
    const del = readScenario({
      steps: [{ operation: "DELETE /items/{id}", role: "admin", pathParams: { id: 1 } }],
    });
    expect(reasons(del).join()).toMatch(/requires approval/);
    expect(reasons(del, { destructiveAllowed: true })).toEqual([]);
    const ops = miniContract().operations;
    const reset = ops.find((o) => o.key === "POST /admin/reset");
    expect(reset && isDestructive(reset)).toBe(true);
  });

  it("rejects copies above the concurrency limit and budget overruns", () => {
    const s = { ...idempotencyScenario(), parallel: { copies: 20 } };
    expect(reasons(s).join()).toMatch(/concurrency limit/);
    expect(reasons(idempotencyScenario(), { remainingRequests: 1 }).join()).toMatch(/only 1 remain/);
  });

  it("rejects undefined variables, accepts extracted ones", () => {
    expect(
      reasons(
        readScenario({ steps: [{ operation: "GET /orders/{id}", pathParams: { id: "{{orderId}}" } }] }),
      ).join(),
    ).toMatch(/undefined variable/);
    expect(
      reasons(
        readScenario({
          steps: [
            { operation: "POST /orders", body: { qty: 1 }, extract: { orderId: "/id" } },
            { operation: "GET /orders/{id}", role: "other", pathParams: { id: "{{orderId}}" } },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("rejects oversized payloads, deep nesting and non-JSON values", () => {
    const big = readScenario({ steps: [{ operation: "GET /items", query: { q: "x".repeat(2000) } }] });
    expect(reasons(big, { maxPayloadBytes: 1000 }).join()).toMatch(/exceeds the limit/);
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { a: deep };
    expect(preflightRaw({ deep }, 16, 1e6).join()).toMatch(/nesting/);
    expect(preflightRaw({ f: () => 1 }, 16, 1e6).length).toBeGreaterThan(0);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(preflightRaw(cyc, 16, 1e6).join()).toMatch(/serialisable/);
  });

  it("audits every rejection", () => {
    const audit: unknown[] = [];
    validateProposal(
      readScenario({ steps: [{ operation: "GET /nope" }] }),
      policy(),
      (e) => audit.push(e),
      "history",
    );
    validateProposal(readScenario(), policy(), (e) => audit.push(e));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "agent.scenario.rejected", detail: { source: "history" } });
  });
});

describe("bandit", () => {
  it("UCB1 tries every untried arm first, in order", () => {
    const b = new Ucb1Bandit();
    const arms = ["a", "b", "c"];
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = b.select(arms);
      seen.push(a);
      b.update(a, 0);
    }
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("UCB1 converges on the best arm for a synthetic reward", () => {
    const rng = createRng(7);
    const p: Record<string, number> = { a: 0.1, b: 0.8, c: 0.3 };
    const b = new Ucb1Bandit(0.5);
    for (let i = 0; i < 600; i++) {
      const a = b.select(Object.keys(p));
      b.update(a, rng.next() < (p[a] as number) ? 1 : 0);
    }
    const st = b.stats();
    expect(st.b?.pulls).toBeGreaterThan((st.a?.pulls ?? 0) + (st.c?.pulls ?? 0));
  });

  it("Thompson sampling is deterministic for a seed and converges", () => {
    const run = (seed: number): string[] => {
      const rng = createRng(seed);
      const env = createRng(seed + 1);
      const b = new ThompsonBandit(rng);
      const out: string[] = [];
      for (let i = 0; i < 300; i++) {
        const a = b.select(["x", "y"]);
        out.push(a);
        b.update(a, env.next() < (a === "y" ? 0.7 : 0.2) ? 1 : 0);
      }
      return out;
    };
    expect(run(3)).toEqual(run(3));
    const tail = run(3).slice(-100);
    expect(tail.filter((a) => a === "y").length).toBeGreaterThan(70);
  });

  it("Beta samples stay in [0,1] with the right mean", () => {
    const rng = createRng(1);
    let sum = 0;
    for (let i = 0; i < 2000; i++) {
      const x = sampleBeta(2, 6, rng);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      sum += x;
    }
    expect(sum / 2000).toBeCloseTo(0.25, 1);
    expect(sampleBeta(0.5, 0.5, rng)).toBeGreaterThanOrEqual(0);
  });

  it("clamps rewards and rejects empty arm lists", () => {
    const b = new Ucb1Bandit();
    b.update("a", 5);
    b.update("a", Number.NaN);
    expect(b.stats().a).toEqual({ pulls: 2, reward: 1, mean: 0.5 });
    expect(() => b.select([])).toThrow();
  });
});

describe("coverage", () => {
  it("tracks documented status coverage and gaps", () => {
    const c = new CoverageTracker();
    c.addDocumented("GET /x", "200");
    c.addDocumented("GET /x", "404");
    expect(c.mark("status", "GET /x", "200")).toBe(true);
    expect(c.mark("status", "GET /x", "200")).toBe(false);
    expect(c.documentedRatio()).toEqual({ observed: 1, total: 2, ratio: 0.5 });
    expect(c.gaps("GET /x", ["200", "404"])).toEqual(["404"]);
    expect(c.counts().status).toBe(1);
  });

  it("grows past the initial bitset size", () => {
    const c = new CoverageTracker();
    for (let i = 0; i < 1000; i++) expect(c.mark("param", "op", i)).toBe(true);
    expect(c.bitsSet).toBe(1000);
    expect(c.has("param", "op", 999)).toBe(true);
    expect(c.has("param", "op", 1000)).toBe(false);
  });

  it("response shapes distinguish types and key sets", () => {
    expect(responseShape(undefined)).toBe("none");
    expect(responseShape([])).toBe("array:empty");
    expect(responseShape({ a: 1 })).not.toBe(responseShape({ b: 1 }));
    expect(responseShape({ a: 1, b: 2 })).toBe(responseShape({ b: 3, a: 4 }));
  });

  it("novelty set and bloom filter skip duplicates", () => {
    for (const mode of ["set", "bloom"] as const) {
      const n = new NoveltySet(mode, 1000);
      expect(n.add("a")).toBe(true);
      expect(n.add("a")).toBe(false);
      expect(n.add("b")).toBe(true);
    }
    const bf = BloomFilter.forCapacity(500, 0.01);
    for (let i = 0; i < 500; i++) bf.add(`k${i}`);
    for (let i = 0; i < 500; i++) expect(bf.has(`k${i}`)).toBe(true);
    let fp = 0;
    for (let i = 0; i < 2000; i++) if (bf.has(`other${i}`)) fp++;
    expect(fp / 2000).toBeLessThan(0.05);
  });
});
