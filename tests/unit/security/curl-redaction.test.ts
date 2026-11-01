/**
 * curl reproductions (src/engines/bugs/http.ts BugsHttp.curl) must not print credentials sent in
 * configured default headers (cookie / x-api-key / custom secret header) or secret query params
 * (threat model I1). Credentials of ROLES are printed as $SW_AUTH_<ROLE>.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { HttpExecutor } from "../../../src/adapters/http/undici-executor.js";
import { createEngineContext } from "../../../src/core/context.js";
import { BugsHttp, type RequestTemplate } from "../../../src/engines/bugs/http.js";

const exec: HttpExecutor = {
  inFlight: 0,
  openSockets: 0,
  async execute() {
    return {
      status: 200,
      bytesIn: 0,
      bytesOut: 0,
      tStart: 0,
      tHeaders: 1,
      tEnd: 1,
      headers: {},
      body: Buffer.from(""),
    };
  },
  async close() {},
} as unknown as HttpExecutor;

const secret = fc
  .stringMatching(/^[A-Za-z0-9][A-Za-z0-9._~+/-]{9,30}$/)
  .filter((s) => /\d/.test(s) && /[a-z]/i.test(s));

function http(headers: Record<string, string>): BugsHttp {
  return new BugsHttp(createEngineContext(), {
    target: "http://127.0.0.1:9",
    timeoutMs: 1000,
    headers,
    roles: { user: { type: "bearer", token: "role-token-123456" } },
    defaultRole: "user",
    invalidToken: "sw-invalid",
    mutationsAllowed: true,
    lease: { take: () => true, remaining: 1e9, release() {} },
    executor: exec,
  } as never);
}

const tpl = (o: Partial<RequestTemplate> = {}): RequestTemplate => ({
  operation: "POST /login",
  method: "POST",
  path: "/login",
  pathParams: {},
  query: {},
  headers: {},
  body: { kind: "none" } as never,
  role: "user",
  ...o,
});

describe("curl reproduction redaction (fast-check)", () => {
  it("role credentials are placeholders", () => {
    const c = http({}).curl(tpl());
    expect(c).toContain("$SW_AUTH_USER");
    expect(c).not.toContain("role-token-123456");
  });

  // Failed before the wave-8 fix (curl printed `?access_token=<v>` and `-H 'cookie: sid=<v>'`).
  it("secrets in default/credential headers, query params and JSON bodies never appear", () => {
    fc.assert(
      fc.property(secret, fc.constantFrom("cookie", "x-api-key", "x-auth-token", "set-cookie"), (v, h) => {
        const value = h.includes("cookie") ? `sid=${v}` : v;
        const c = http({ [h]: value }).curl(
          tpl({ query: { access_token: v }, body: { kind: "json", value: { password: v } } as never }),
        );
        expect(c.includes(v) || c.includes(encodeURIComponent(v)), c).toBe(false);
        // The reader is told a value was withheld (like $SW_AUTH_* for role credentials).
        expect(c).toContain(`${h}: [REDACTED]`);
        expect(c).toContain("access_token=%5BREDACTED%5D");
        return true;
      }),
      { numRuns: 300, seed: 0x5ec_0c41 },
    );
  });
});
