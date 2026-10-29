import { describe, expect, it } from "vitest";
import { createRedactor } from "../../../src/core/log/redact.js";
import { HAR_REDACTED, toHar } from "../../../src/engines/bugs/har.js";
import { type Exchange, ROLE_INVALID } from "../../../src/engines/bugs/http.js";
import type { Credential } from "../../../src/engines/bugs/schema.js";
import { validateHar12 } from "../../integration/bugs/har-validate.js";

const roles: Record<string, Credential> = {
  user: { type: "bearer", token: "alice-secret-token-123" },
  ops: { type: "basic", username: "ops", password: "hunter2-pass" },
  svc: { type: "header", name: "X-Service-Key", value: "svc-key-998877" },
};
const SECRETS = [
  "alice-secret-token-123",
  "hunter2-pass",
  Buffer.from("ops:hunter2-pass").toString("base64"),
  "svc-key-998877",
  "sessid-abcdef",
  "query-secret-zz",
  "sw-invalid-token-0000",
];

function ex(
  p: Partial<Exchange> & { role: Exchange["role"]; requestHeaders: Record<string, string> },
): Exchange {
  return {
    operation: "POST /orders",
    method: "POST",
    url: "http://127.0.0.1:3000/orders",
    status: 201,
    responseHeaders: { "content-type": "application/json" },
    contentType: "application/json",
    durationMs: 3,
    tStart: 100,
    tEnd: 103,
    rateLimitedRetries: 0,
    ...p,
  };
}

// Raw (deliberately UNredacted) exchanges: toHar must not rely on upstream redaction.
const exchanges: Exchange[] = [
  ex({
    role: "user",
    requestHeaders: {
      authorization: "Bearer alice-secret-token-123",
      "content-type": "application/json",
      cookie: "sid=sessid-abcdef",
    },
    requestBody: '{"items":[{"productId":20,"qty":1}]}',
    responseHeaders: { "content-type": "application/json", "set-cookie": "sid=sessid-abcdef; HttpOnly" },
    responseBody: '{"id":"ord_1"}',
  }),
  ex({
    role: "ops",
    method: "GET",
    url: "http://ops:hunter2-pass@127.0.0.1:3000/orders/ord_1?access_token=query-secret-zz&limit=2",
    requestHeaders: { authorization: `Basic ${Buffer.from("ops:hunter2-pass").toString("base64")}` },
    status: 200,
    tStart: 104,
    tEnd: 110,
  }),
  ex({
    role: "svc",
    method: "GET",
    requestHeaders: { "x-service-key": "svc-key-998877" },
    status: 404,
    tStart: 111,
    tEnd: 112,
  }),
  ex({
    role: ROLE_INVALID,
    method: "GET",
    requestHeaders: { authorization: "Bearer sw-invalid-token-0000" },
    status: 401,
  }),
  ex({ role: "user", requestHeaders: {}, status: 0, error: "timeout: no response", tStart: 120, tEnd: 5120 }),
  ex({ role: "user", requestHeaders: {}, status: 0, blocked: "mutation" }),
];

describe("HAR 1.2 export of reproductions", () => {
  const har = toHar(exchanges, {
    roles,
    startedIso: "2026-10-29T12:00:00.000Z",
    redactor: createRedactor({ secrets: SECRETS }),
    comment: "bugs/race-lost-update POST /orders",
  });
  const text = JSON.stringify(har);

  it("validates against the HAR 1.2 required fields", () => {
    expect(validateHar12(har)).toEqual([]);
    expect(validateHar12(JSON.parse(text))).toEqual([]);
    expect(har.log.entries).toHaveLength(5); // blocked requests were never sent
    expect(har.log.entries[1]?.startedDateTime).toBe("2026-10-29T12:00:00.004Z");
    expect(har.log.entries[0]?.request.postData?.text).toContain("productId");
    expect(har.log.entries[4]?.response._error).toMatch(/timeout/);
  });

  it("the validator rejects documents missing required fields", () => {
    const broken = JSON.parse(text);
    delete broken.log.entries[0].request.httpVersion;
    delete broken.log.entries[0].timings;
    broken.log.version = "1.1";
    expect(validateHar12(broken).length).toBe(3);
  });

  it("credentials become $SW_AUTH_<ROLE> placeholders, exactly as in curl", () => {
    const h = (i: number, n: string) => har.log.entries[i]?.request.headers.find((x) => x.name === n)?.value;
    expect(h(0, "authorization")).toBe("$SW_AUTH_USER");
    expect(h(1, "authorization")).toBe("$SW_AUTH_OPS");
    expect(h(2, "x-service-key")).toBe("$SW_AUTH_SVC");
    expect(h(3, "authorization")).toBe(HAR_REDACTED);
    expect(h(0, "cookie")).toBe(HAR_REDACTED);
    expect(har.log.entries[0]?.response.headers.find((x) => x.name === "set-cookie")?.value).toBe(
      HAR_REDACTED,
    );
    expect(har.log.entries[1]?.request.queryString).toEqual([
      { name: "access_token", value: HAR_REDACTED },
      { name: "limit", value: "2" },
    ]);
    expect(har.log.entries[1]?.request.url).not.toContain("@");
  });

  it("contains no secret anywhere", () => {
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).not.toMatch(/Bearer [^$\s"]/);
    expect(text).not.toMatch(/Basic [A-Za-z0-9+/=]{6,}/);
  });
});
