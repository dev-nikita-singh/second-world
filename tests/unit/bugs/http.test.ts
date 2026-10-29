import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  HttpExecutor,
  HttpRequestSpec,
  HttpResult,
} from "../../../src/adapters/http/undici-executor.js";
import { createEngineContext } from "../../../src/core/context.js";
import type { BudgetLease } from "../../../src/core/types.js";
import { runCase } from "../../../src/engines/bugs/cases.js";
import { indexContract } from "../../../src/engines/bugs/contract.js";
import { BudgetExhausted, BugsHttp, type RequestTemplate } from "../../../src/engines/bugs/http.js";

function fakeExecutor(responses: Partial<HttpResult>[]): HttpExecutor & { seen: HttpRequestSpec[] } {
  const seen: HttpRequestSpec[] = [];
  let i = 0;
  return {
    seen,
    inFlight: 0,
    openSockets: 0,
    async execute(req) {
      seen.push(req);
      const r = responses[Math.min(i++, responses.length - 1)] ?? {};
      return { status: 200, bytesIn: 0, bytesOut: 0, tStart: 0, tHeaders: 1, tEnd: 2, headers: {}, ...r };
    },
    async close() {},
  };
}

function lease(n = 100): BudgetLease {
  let left = n;
  return {
    take: () => left-- > 0,
    get remaining() {
      return left;
    },
    release() {},
  };
}

// Contract for GET /x/{id} so the timeout case is a real conformance check (not "contract missing").
const X_CONTRACT = indexContract({
  openapi: "3.1.0",
  info: { title: "x", version: "1" },
  paths: { "/x/{id}": { get: { responses: { "200": { description: "ok" } } } } },
});

const tpl = (over: Partial<RequestTemplate> = {}): RequestTemplate => ({
  operation: "GET /x",
  method: "GET",
  path: "/x/{id}",
  pathParams: { id: 5 },
  query: { q: "a b" },
  headers: {},
  body: { kind: "none" },
  secured: true,
  ...over,
});

function http(exec: HttpExecutor, opts: { mutations?: boolean; budget?: number } = {}) {
  return new BugsHttp(createEngineContext(), {
    target: "http://127.0.0.1:9/api",
    timeoutMs: 1000,
    headers: {},
    roles: { user: { type: "bearer", token: "secret-user-token" } },
    defaultRole: "user",
    invalidToken: "sw-invalid",
    mutationsAllowed: opts.mutations ?? false,
    lease: lease(opts.budget),
    executor: exec,
  });
}

describe("BugsHttp", () => {
  it("builds paths, query and auth; records redacted exchanges", async () => {
    const exec = fakeExecutor([
      { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"ok":true}') },
    ]);
    const h = http(exec);
    const ex = await h.send(tpl());
    expect(exec.seen[0]?.path).toBe("/api/x/5?q=a%20b");
    expect(exec.seen[0]?.headers).toContain("Bearer secret-user-token");
    expect(ex.json).toEqual({ ok: true });
    expect(JSON.stringify(ex.requestHeaders)).not.toContain("secret-user-token");
    expect(h.curl(tpl())).toContain("$SW_AUTH_USER");
    expect(h.curl(tpl())).not.toContain("secret-user-token");
  });

  it("backs off on 429 using Retry-After and does not count it as a result", async () => {
    const exec = fakeExecutor([{ status: 429, headers: { "retry-after": "0" } }, { status: 200 }]);
    const h = http(exec);
    const ex = await h.send(tpl());
    expect(ex.status).toBe(200);
    expect(ex.rateLimitedRetries).toBe(1);
    expect(h.stats.rateLimited).toBe(1);
  });

  it("blocks mutating requests without allowMutations (never sent)", async () => {
    const exec = fakeExecutor([{ status: 201 }]);
    const h = http(exec, { mutations: false });
    const ex = await h.send(tpl({ method: "POST" }));
    expect(ex.blocked).toBe("mutation");
    expect(exec.seen).toHaveLength(0);
    expect(h.stats.mutationsBlocked).toBe(1);
  });

  it("stops when the request budget is exhausted", async () => {
    const h = http(fakeExecutor([{ status: 200 }]), { budget: 1 });
    await h.send(tpl());
    await expect(h.send(tpl())).rejects.toBeInstanceOf(BudgetExhausted);
  });

  it("generator timeouts are inconclusive, not bugs", async () => {
    const exec = fakeExecutor([{ status: 0, error: { kind: "timeout", message: "timed out" } }]);
    const h = http(exec);
    const run = await runCase(
      {
        id: "c",
        technique: "contract",
        operation: "GET /x/{id}",
        label: "t",
        seed: 1,
        steps: [{ request: tpl({ operation: "GET /x/{id}" }), expect: "valid" }],
        check: { kind: "conformance" },
      },
      {
        http: h,
        contract: X_CONTRACT,
        opsByKey: new Map(X_CONTRACT.operations.map((o) => [o.key, o])),
        assertions: [],
        invariants: [],
        concurrency: [],
        concurrencyFns: new Map(),
      },
    );
    expect(run.inconclusive).toBe(true);
    expect(run.failures).toEqual([]);
    expect(h.stats.transportErrors).toBe(1);
  });

  it("bursts dispatch every request after the barrier", async () => {
    const exec = fakeExecutor([{ status: 201 }]);
    const h = http(exec, { mutations: true });
    const r = await h.burst(
      Array.from({ length: 6 }, () => tpl({ method: "POST", body: { kind: "json", value: { a: 1 } } })),
    );
    expect(r).toHaveLength(6);
    expect(exec.seen).toHaveLength(6);
  });
});

describe("curl reproductions", () => {
  const roles = {
    user: { type: "bearer" as const, token: "secret-user-token" },
    other: { type: "basic" as const, username: "bob", password: "secret-bob-pass" },
    svc: { type: "header" as const, name: "X-Api-Key", value: "secret-api-key" },
  };
  const h = new BugsHttp(createEngineContext(), {
    target: "http://127.0.0.1:9",
    timeoutMs: 1000,
    headers: {},
    roles,
    defaultRole: "user",
    invalidToken: "sw-invalid",
    mutationsAllowed: true,
    lease: lease(),
    executor: fakeExecutor([{ status: 200 }]),
  });
  const AUTH_HEADER = /-H "(authorization|x-api-key): ([^"]*)"/g;

  it("emits exactly one $SW_AUTH_<ROLE> per credential header, with no scheme prefix", () => {
    for (const [role, header] of [
      ["user", "authorization"],
      ["other", "authorization"],
      ["svc", "x-api-key"],
    ] as const) {
      const c = h.curl(tpl({ role }));
      const m = [...c.matchAll(AUTH_HEADER)];
      expect(m, c).toHaveLength(1);
      expect(m[0]?.[1]).toBe(header);
      expect(m[0]?.[2]).toBe(`$SW_AUTH_${role.toUpperCase()}`);
      expect(c).not.toMatch(/Bearer|Basic|secret-/);
    }
  });

  it("multi-step reproductions use the recorded values (never {{var}} or %7B%7B)", () => {
    const steps = [
      {
        request: tpl({ method: "POST", path: "/orders", pathParams: {}, query: {} }),
        extract: { rid: "/id" },
      },
      { request: tpl({ path: "/orders/{id}", pathParams: { id: "{{rid}}" }, query: {}, role: "other" }) },
    ];
    const resolved = [
      steps[0]?.request,
      { ...(steps[1]?.request as RequestTemplate), pathParams: { id: "ord_7" } },
    ];
    const out = h.curlSteps(steps, resolved);
    expect(out[1]).toContain("http://127.0.0.1:9/orders/ord_7");
    for (const c of out) expect(c).not.toMatch(/\{\{|%7B%7B/i);
  });

  it("falls back to a shell capture when a value is unknown", () => {
    const steps = [
      {
        request: tpl({ method: "POST", path: "/orders", pathParams: {}, query: {} }),
        extract: { rid: "/id" },
      },
      {
        request: tpl({
          path: "/orders/{id}",
          pathParams: { id: "{{rid}}" },
          query: {},
          body: { kind: "json", value: { ref: "{{rid}}" } },
        }),
      },
    ];
    const out = h.curlSteps(steps);
    expect(out[0]).toMatch(/^RID=\$\(curl .* \| node -e '/);
    expect(out[1]).toContain(`'http://127.0.0.1:9/orders/'"$RID"''`);
    expect(out[1]).toContain(`'{"ref":"'"$RID"'"}'`);
    for (const c of out) expect(c).not.toMatch(/\{\{|%7B%7B/i);
  });

  it("never prints templates for arbitrary variable names (property)", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/), fc.boolean(), (v, recorded) => {
        const steps = [
          {
            request: tpl({ method: "POST", path: "/r", pathParams: {}, query: {} }),
            extract: { [v]: "/id" },
          },
          {
            request: tpl({
              path: "/r/{id}",
              pathParams: { id: `{{${v}}}` },
              query: { q: `x{{${v}}}` },
              headers: { "x-ref": `{{${v}}}` },
            }),
          },
        ];
        const resolved = recorded
          ? [
              steps[0]?.request,
              {
                ...(steps[1]?.request as RequestTemplate),
                pathParams: { id: 5 },
                query: { q: "x5" },
                headers: { "x-ref": "5" },
              },
            ]
          : [];
        for (const c of h.curlSteps(steps, resolved)) expect(c).not.toMatch(/\{\{|%7B%7B/i);
      }),
      { numRuns: 60 },
    );
  });

  it("burst steps are rendered as concurrent background requests", () => {
    const out = h.curlSteps([{ request: tpl({ method: "POST" }), burst: 5 }]);
    expect(out[0]).toMatch(/^for i in \$\(seq 1 5\); do curl .* & done; wait$/);
  });
});
