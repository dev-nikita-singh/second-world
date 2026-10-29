/**
 * Property test for the safety validator (docs/03-engines/adversarial-test-agent.md §5):
 * random proposals, valid and invalid, with an independent oracle built from the generator's
 * own labels. No proposal that violates the policy is ever accepted, and clean proposals are.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { validateProposal } from "../../../src/engines/agent/safety.js";
import { policy, readScenario } from "./fixtures.js";

interface OpChoice {
  key: string;
  known: boolean;
  mutating: boolean;
  destructive: boolean;
  pathParam: boolean;
}

const OPS: OpChoice[] = [
  { key: "GET /items", known: true, mutating: false, destructive: false, pathParam: false },
  { key: "GET /items/{id}", known: true, mutating: false, destructive: false, pathParam: true },
  { key: "GET /orders/{id}", known: true, mutating: false, destructive: false, pathParam: true },
  { key: "POST /orders", known: true, mutating: true, destructive: false, pathParam: false },
  { key: "DELETE /items/{id}", known: true, mutating: true, destructive: true, pathParam: true },
  { key: "POST /admin/reset", known: true, mutating: true, destructive: true, pathParam: false },
  { key: "GET /secret", known: false, mutating: false, destructive: false, pathParam: false },
  { key: "PATCH /items/{id}", known: false, mutating: true, destructive: false, pathParam: true },
];

const safeToken = fc.stringMatching(/^[a-z0-9]{1,12}$/);

const roleArb = fc.oneof(
  fc.constantFrom("user", "other", "admin", null, "$invalid").map((r) => ({ role: r, bad: false })),
  fc.constantFrom("root", "guest", "superuser", "prod-user").map((r) => ({ role: r, bad: true })),
);

const pathValueArb = fc.oneof(
  fc
    .oneof(safeToken, fc.integer({ min: 1, max: 1000 }))
    .map((v) => ({ v: v as string | number, bad: false })),
  fc
    .tuple(fc.constantFrom("..", "../", "a/b", "%2e%2e", "x\\y", "..%2fadmin", "%2F", "."), safeToken)
    .map(([t, s]) => ({ v: t === "." ? "." : `${s}${t}`, bad: true })),
);

const queryValueArb = fc.oneof(
  safeToken.map((v) => ({ v, bad: false })),
  fc
    .tuple(fc.constantFrom("127.0.0.1", "localhost", "127.0.0.1:8080"), safeToken)
    .map(([h, p]) => ({ v: `http://${h}/${p}`, bad: false })),
  fc
    .tuple(
      fc.constantFrom("http", "https", "ftp", "gopher"),
      fc.constantFrom("example.com", "10.0.0.1", "169.254.169.254", "evil.test", "user@example.org"),
      safeToken,
    )
    .map(([s, h, p]) => ({ v: `${s}://${h}/${p}`, bad: true })),
);

const stepArb = fc.record({
  op: fc.constantFrom(...OPS),
  role: roleArb,
  pv: pathValueArb,
  qv: queryValueArb,
});

const proposalArb = fc.record({
  steps: fc.array(stepArb, { minLength: 1, maxLength: 4 }),
  copies: fc.option(fc.integer({ min: 2, max: 50 }), { nil: undefined }),
  mutationsAllowed: fc.boolean(),
  destructiveAllowed: fc.boolean(),
  remaining: fc.option(fc.integer({ min: 0, max: 200 }), { nil: undefined }),
});

const MAX_COPIES = 10;

describe("safety validator (property)", () => {
  it("never accepts a proposal that violates the policy; always accepts clean ones", () => {
    let accepted = 0;
    let rejected = 0;
    fc.assert(
      fc.property(proposalArb, (p) => {
        const violations: string[] = [];
        const steps = p.steps.map((s) => {
          if (!s.op.known) violations.push("unknown-op");
          if (s.op.mutating && !p.mutationsAllowed) violations.push("mutation");
          if (s.op.destructive && !p.destructiveAllowed) violations.push("destructive");
          if (s.role.bad) violations.push("role");
          if (s.qv.bad) violations.push("host");
          if (s.op.pathParam && s.pv.bad) violations.push("traversal");
          const st: Record<string, unknown> = {
            operation: s.op.key,
            role: s.role.role,
            query: { q: s.qv.v },
          };
          if (s.op.pathParam) st.pathParams = { id: s.pv.v };
          if (s.op.key === "POST /orders") st.body = { qty: 1 };
          return st;
        });
        if (p.copies !== undefined && p.copies > MAX_COPIES) violations.push("copies");
        const requests = steps.length + (p.copies === undefined ? 0 : p.copies - 1);
        if (p.remaining !== undefined && requests > p.remaining) violations.push("budget");
        const raw = {
          ...readScenario({ steps: steps as never }),
          ...(p.copies ? { parallel: { copies: p.copies } } : {}),
        };
        const r = validateProposal(
          raw,
          policy({
            mutationsAllowed: p.mutationsAllowed,
            destructiveAllowed: p.destructiveAllowed,
            maxCopies: MAX_COPIES,
            ...(p.remaining === undefined ? {} : { remainingRequests: p.remaining }),
          }),
        );
        if (r.ok) accepted++;
        else rejected++;
        if (violations.length > 0) {
          expect(r.ok, `accepted despite ${violations.join(",")}: ${JSON.stringify(raw)}`).toBe(false);
        } else {
          expect(r.ok ? [] : r.reasons, JSON.stringify(raw)).toEqual([]);
        }
      }),
      { numRuns: 2000, seed: 20261029 },
    );
    // Both branches are exercised substantially.
    expect(accepted).toBeGreaterThan(20);
    expect(rejected).toBeGreaterThan(500);
  });

  it("injecting any unknown key anywhere in a valid proposal is rejected", () => {
    const base = readScenario({
      steps: [{ operation: "GET /items/{id}", role: "user", pathParams: { id: 1 } }],
      assertions: [{ kind: "status", step: 0, oneOf: [200, 404] }],
    });
    const targets = ["", "steps.0", "assertions.0"];
    fc.assert(
      fc.property(
        fc.constantFrom(...targets),
        fc
          .stringMatching(/^[a-z][a-zA-Z]{2,10}$/)
          .filter(
            (k) =>
              ![
                "title",
                "hypothesis",
                "setup",
                "steps",
                "parallel",
                "assertions",
                "expectedClassification",
                "operation",
                "role",
                "pathParams",
                "query",
                "headers",
                "body",
                "extract",
                "label",
                "kind",
                "step",
                "oneOf",
                "rule",
              ].includes(k),
          ),
        fc.jsonValue(),
        (where, key, val) => {
          const raw = structuredClone(base) as Record<string, unknown>;
          let obj: Record<string, unknown> = raw;
          for (const seg of where.split(".").filter(Boolean)) obj = obj[seg] as Record<string, unknown>;
          obj[key] = val;
          expect(validateProposal(raw, policy()).ok).toBe(false);
        },
      ),
      { numRuns: 500, seed: 7 },
    );
  });

  it("arbitrary JSON values are never accepted", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(validateProposal(v, policy()).ok).toBe(false);
      }),
      { numRuns: 1000, seed: 11 },
    );
  });
});
