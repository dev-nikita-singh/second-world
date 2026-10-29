import { describe, expect, it } from "vitest";
import { classifyError } from "../../../src/adapters/http/errors.js";
import type { HttpResult } from "../../../src/adapters/http/undici-executor.js";
import { createRng } from "../../../src/core/rng.js";
import {
  checkResponse,
  compilePlan,
  parseCsv,
  parseJsonPath,
  pickScenario,
  renderRequest,
} from "../../../src/engines/performance/prepare.js";
import { PerformanceInputSchema } from "../../../src/engines/performance/schema.js";

function err(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { code, ...extra });
}

describe("classifyError", () => {
  it("maps transport errors to stable kinds", () => {
    expect(classifyError(err("ECONNREFUSED"))).toBe("econnrefused");
    expect(classifyError(err("ECONNRESET"))).toBe("econnreset");
    expect(classifyError(err("EPIPE"))).toBe("epipe");
    expect(classifyError(err("ENOTFOUND"))).toBe("dns");
    expect(classifyError(err("EAI_AGAIN"))).toBe("dns");
    expect(classifyError(err("UND_ERR_CONNECT_TIMEOUT"))).toBe("connect-timeout");
    expect(classifyError(err("UND_ERR_HEADERS_TIMEOUT"))).toBe("timeout");
    expect(classifyError(err("UND_ERR_SOCKET", { cause: err("ECONNRESET") }))).toBe("econnreset");
    expect(classifyError(err("UND_ERR_SOCKET"))).toBe("socket");
    expect(classifyError(err("UND_ERR_ABORTED"))).toBe("aborted");
    expect(classifyError(new Error("weird"))).toBe("other");
  });

  it("our own timeout/cancel flags win over the generic abort error", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyError(abort, { timedOut: true })).toBe("timeout");
    expect(classifyError(abort, { cancelled: true })).toBe("aborted");
  });
});

describe("prepare", () => {
  const input = PerformanceInputSchema.parse({
    target: "http://127.0.0.1:3000/base/",
    auth: { type: "bearer", token: "T" },
    scenarios: [
      {
        name: "browse",
        weight: 3,
        steps: [{ path: "/p", query: { page: "{{rand 1 1}}", q: "a b" }, expect: { status: 200 } }],
      },
      {
        name: "checkout",
        weight: 1,
        steps: [
          {
            method: "POST",
            path: "cart",
            json: { sku: "X" },
            extract: { id: "$.items[0].id", loc: "header:location" },
          },
          {
            method: "POST",
            path: "/orders",
            json: { cartId: "{{id}}" },
            headers: { "Idempotency-Key": "{{seq}}" },
          },
        ],
      },
    ],
  });
  const plan = compilePlan(input);

  it("compiles origins, keys, headers and bodies", () => {
    expect(plan.origins).toEqual(["http://127.0.0.1:3000"]);
    const [browse, checkout] = plan.scenarios;
    expect(browse?.steps[0]?.key).toBe("GET /p");
    expect(checkout?.steps[0]?.key).toBe("POST /base/cart");
    const s0 = checkout?.steps[0];
    expect(Buffer.isBuffer(s0?.body)).toBe(true);
    expect(s0?.staticHeaders).toContain("authorization");
    expect(s0?.staticHeaders).toContain("Bearer T");
    expect(s0?.readBody).toBe(true);
    expect(browse?.steps[0]?.readBody).toBe(false);
  });

  it("renders requests per iteration (query templates URI-encoded, dynamic headers)", () => {
    let seq = 0;
    const scope = { rng: createRng(1), vars: { id: "c-1" }, nextSeq: () => ++seq, epochMs: () => 0 };
    const r = renderRequest(plan.scenarios[0]?.steps[0] as never, scope);
    expect(r.path).toBe("/p?page=1&q=a b");
    const o = renderRequest(plan.scenarios[1]?.steps[1] as never, scope);
    expect(o.body).toBe('{"cartId":"c-1"}');
    expect(o.headers).toContain("idempotency-key");
    expect(o.headers).toContain("1");
  });

  it("checks status and extracts json/header values", () => {
    const step = plan.scenarios[1]?.steps[0];
    const vars: Record<string, string> = {};
    const res: HttpResult = {
      status: 201,
      headers: { location: "/cart/9" },
      body: Buffer.from(JSON.stringify({ items: [{ id: 9 }] })),
      bytesIn: 1,
      bytesOut: 1,
      tStart: 0,
      tHeaders: 0,
      tEnd: 0,
    };
    expect(checkResponse(step as never, res, vars)).toEqual({ ok: true });
    expect(vars).toEqual({ id: "9", loc: "/cart/9" });
    expect(checkResponse(step as never, { ...res, body: Buffer.from("{}") }, {})).toMatchObject({
      ok: false,
      kind: "extract",
    });
    expect(checkResponse(step as never, { ...res, status: 503 }, {})).toMatchObject({
      ok: false,
      kind: "status",
    });
    const browse = plan.scenarios[0]?.steps[0];
    expect(checkResponse(browse as never, { ...res, status: 201 }, {})).toMatchObject({
      ok: false,
      kind: "status",
    });
  });

  it("picks scenarios by weight", () => {
    const rng = createRng(3);
    let browse = 0;
    for (let i = 0; i < 4000; i++) if (pickScenario(plan, rng).name === "browse") browse++;
    expect(browse / 4000).toBeGreaterThan(0.72);
    expect(browse / 4000).toBeLessThan(0.78);
  });

  it("parses JSON paths and CSV", () => {
    expect(parseJsonPath("$.a.b[2]['c d']")).toEqual(["a", "b", 2, "c d"]);
    expect(() => parseJsonPath("a.b")).toThrow();
    expect(parseCsv('sku,name\r\nA1,"x, ""y"""\nB2,z\n')).toEqual([
      { sku: "A1", name: 'x, "y"' },
      { sku: "B2", name: "z" },
    ]);
  });
});
