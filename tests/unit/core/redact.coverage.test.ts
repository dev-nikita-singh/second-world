/**
 * Coverage + adversarial tests for the redaction pipeline (docs/11 §4, docs/04 §9.4).
 * Owner: sw-coverage (Wave 5).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRedactor, redactionMarker, shannonEntropy } from "../../../src/core/log/redact.js";

const MARK = /«redacted:[0-9a-f]{8}»/;

describe("shannonEntropy", () => {
  it("edge cases and bounds", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("ab")).toBeCloseTo(1);
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 64 }), (s) => {
        const h = shannonEntropy(s);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(Math.log2([...s].length) + 1e-9);
      }),
    );
  });
});

describe("exact secrets", () => {
  it("any added secret (≥ 4 chars, regex metacharacters included) never survives in output", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 4, maxLength: 24 }), fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (secret, pre, post) => {
        const r = createRedactor({ secrets: [secret], entropy: false });
        const out = r.redactString(`${pre}${secret}${post}`);
        expect(out).toContain(redactionMarker(secret));
      }),
    );
  });

  it("short secrets are ignored; longest secret wins on overlap; non-strings ignored", () => {
    const r = createRedactor();
    r.addSecret("abc");
    r.addSecret(42 as unknown as string);
    expect(r.redactString("abc")).toBe("abc");
    r.addSecret("pass");
    r.addSecret("password123");
    r.addSecret("password123"); // duplicate: no rebuild
    expect(r.redactString("x=password123")).toBe(`x=${redactionMarker("password123")}`);
    expect(r.redactString("")).toBe("");
  });

  it("markers are deterministic and correlatable", () => {
    expect(redactionMarker("same")).toBe(redactionMarker("same"));
    expect(redactionMarker("same")).not.toBe(redactionMarker("other"));
  });
});

describe("patterns", () => {
  const r = createRedactor();
  it.each([
    ["bearer header text", "Authorization: Bearer abcdefgh12345678", "abcdefgh12345678"],
    ["aws access key", "key AKIAABCDEFGHIJKLMNOP here", "AKIAABCDEFGHIJKLMNOP"],
    ["aws secret", `aws_secret_access_key = "${"a".repeat(20)}${"B/".repeat(10)}"`, "B/B/B/B/B/"],
    ["gcp key", `AIza${"x".repeat(35)}`, "x".repeat(35)],
    ["anthropic key", `sk-ant-${"q".repeat(24)}`, "q".repeat(24)],
    ["github token", `ghp_${"Z".repeat(36)}`, "Z".repeat(36)],
    ["slack token", "xoxb-1234567890-abcdef", "1234567890-abcdef"],
    ["stripe", `sk_live_${"9".repeat(24)}`, "9".repeat(24)],
    ["azure", `AccountKey=${"k".repeat(30)};`, "k".repeat(30)],
    ["url basic auth", "postgres://admin:s3cr3tpw@db:5432/x", "s3cr3tpw"],
    ["conn string", "Server=db;Password=hunter22;Database=x", "hunter22"],
    ["jwt", "token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl", "c2lnbmF0dXJl"],
    ["pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "MIIEow"],
  ])("%s", (_n, input, leaked) => {
    const out = r.redactString(input);
    expect(out).not.toContain(leaked);
    expect(out).toMatch(MARK);
  });

  it("already-redacted text is stable (idempotent)", () => {
    const once = r.redactString("Bearer abcdefgh12345678 and postgres://u:pw123456@h/x");
    expect(r.redactString(once)).toBe(once);
  });

  it("custom patterns: RegExp (non-global made global) and named with a group", () => {
    const c = createRedactor({
      patterns: [/INTERNAL-\d{4}/, { name: "pin", re: /pin=(\d{4})/, group: 1 }, /already-global-\d/g],
    });
    const out = c.redactString("id INTERNAL-1234 pin=9876 INTERNAL-5678 already-global-1");
    expect(out).not.toMatch(/INTERNAL-\d|9876|already-global-1/);
    expect(out).toContain("pin=«redacted:");
  });

  it("entropy rule redacts high-entropy values next to key-like names only", () => {
    const hi = "Zx9Qw3Er7Ty1Ui5Op2As8Df";
    expect(r.redactString(`api_token=${hi}`)).not.toContain(hi);
    expect(r.redactString(`description=${hi}`)).toContain(hi);
    // A clearly sensitive name is redacted whatever the entropy (hex tokens stay below 4.0, 9d809d9);
    // a looser key-like name still needs high entropy.
    expect(r.redactString(`token=${"a".repeat(30)}`)).not.toContain("a".repeat(30));
    expect(r.redactString(`monkey=${"a".repeat(30)}`)).toContain("a".repeat(30));
    const off = createRedactor({ entropy: false });
    expect(off.redactString(`api_token=${hi}`)).toContain(hi);
  });

  it("secrets in URL query strings with key-like names are redacted", () => {
    const tok = "Zx9Qw3Er7Ty1Ui5Op2As8Df";
    const out = r.redactString(`GET http://127.0.0.1:3000/cb?access_token=${tok}&x=1`);
    expect(out).not.toContain(tok);
    expect(out).toContain("&x=1");
  });
});

describe("headers", () => {
  it("redacts known headers (any case, arrays, null) and pattern-scans others", () => {
    const r = createRedactor({ headers: ["Authorization", "X-Custom-Secret"] });
    const out = r.redactHeaders({
      AUTHORIZATION: "Basic dXNlcjpwYXNz",
      "x-custom-secret": ["a", "b"],
      cookie: "sid=abc", // not in the custom list → only patterns
      "x-forward": ["Bearer abcdefgh12345678", 3 as unknown as string],
      "x-null": null,
      "x-num": 5,
    } as Record<string, unknown>);
    expect(out.AUTHORIZATION).toMatch(MARK);
    expect(out["x-custom-secret"]).toEqual([redactionMarker("a"), redactionMarker("b")]);
    expect(out.cookie).toBe("sid=abc");
    expect((out["x-forward"] as string[])[0]).toMatch(MARK);
    expect((out["x-forward"] as unknown[])[1]).toBe(3);
    expect(out["x-null"]).toBeNull();
    expect(out["x-num"]).toBe(5);
    expect(createRedactor().redactHeaders({ "Set-Cookie": undefined } as Record<string, unknown>)["Set-Cookie"]).toBeUndefined();
    expect(createRedactor().redactHeaders(undefined as unknown as Record<string, unknown>)).toEqual({});
  });
});

describe("redactObject", () => {
  const r = createRedactor({ secrets: ["s3cr3t-value"] });

  it("primitives and strings at the root", () => {
    expect(r.redactObject("has s3cr3t-value")).toContain("«redacted:");
    expect(r.redactObject(5)).toBe(5);
    expect(r.redactObject(null)).toBeNull();
  });

  it("walks nested structures, cycles, special objects and errors", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const err = Object.assign(new Error("failed with s3cr3t-value"), { code: "E1" });
    const out = r.redactObject({
      cyc,
      when: new Date("2026-01-01T00:00:00Z"),
      url: new URL("http://u:pw12345678@h/x"),
      buf: Buffer.from("abc"),
      view: new Uint8Array(4),
      big: 10n,
      list: ["s3cr3t-value", { password: "short" }],
      err,
      fn: undefined,
    }) as Record<string, any>;
    expect(out.cyc.self).toBe("[Circular]");
    expect(out.when).toBe("2026-01-01T00:00:00.000Z");
    expect(out.url).not.toContain("pw12345678");
    expect(out.buf).toBe("[binary 3 bytes]");
    expect(out.view).toBe("[binary 4 bytes]");
    expect(out.big).toBe("10");
    expect(out.list[0]).toMatch(MARK);
    expect(out.list[1].password).toMatch(MARK);
    expect(out.err.message).not.toContain("s3cr3t-value");
    expect(out.err.code).toBe("E1");
    expect(out.err.stack).not.toContain("s3cr3t-value");
  });

  it("array elements are not key-forced; already-redacted values are kept", () => {
    const m = redactionMarker("x");
    const out = r.redactObject({ token: m, arr: ["plain"] }) as Record<string, any>;
    expect(out.token).toBe(m);
    expect(out.arr[0]).toBe("plain");
  });

  it("does not recurse on deep input (no stack overflow)", () => {
    let o: Record<string, unknown> = { v: "leaf s3cr3t-value" };
    for (let i = 0; i < 20_000; i++) o = { n: o };
    expect(() => r.redactObject(o)).not.toThrow();
  });

  it("snake/kebab/plain sensitive keys are always redacted, whatever the value", () => {
    for (const k of ["password", "db_password", "api-key", "apikey", "client_secret", "refresh_token", "x-auth-token", "session_id", "credentials", "Authorization"]) {
      const out = r.redactObject({ [k]: "v1" }) as Record<string, string>;
      expect(out[k], k).toMatch(MARK);
    }
  });

  // Regression (sw-coverage bug report, fixed by main): SENSITIVE_KEY (src/core/log/redact.ts) used to match the keyword only as a whole
  // key or after a `_`/`-` separator, so camelCase keys common in JSON login responses
  // (accessToken, refreshToken, authToken, idToken, userPassword) are NOT redacted; a low-entropy or
  // hex opaque token under such a key leaks into reports/artifacts.
  it("camelCase sensitive keys (accessToken, refreshToken, userPassword) are redacted", () => {
    const out = r.redactObject({
      accessToken: "8f14e45fceea167a5a36dedd4bea2543",
      refreshToken: "rt-1234",
      userPassword: "letmein1",
    }) as Record<string, string>;
    expect(out.accessToken).toMatch(MARK);
    expect(out.refreshToken).toMatch(MARK);
    expect(out.userPassword).toMatch(MARK);
  });
});
