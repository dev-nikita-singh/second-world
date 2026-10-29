import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createLogger, createMemoryLogger, silentLogger } from "../../../src/core/log/logger.js";
import { createRedactor, redactionMarker, shannonEntropy } from "../../../src/core/log/redact.js";

const r = createRedactor();
const MARK = /«redacted:[0-9a-f]{8}»/;

describe("redactString patterns", () => {
  const cases: Array<[string, string, string]> = [
    ["bearer", "Authorization: Bearer abcdef0123456789xyz", "abcdef0123456789xyz"],
    [
      "jwt",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U here",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
    ["aws", "key=AKIAIOSFODNN7EXAMPLE end", "AKIAIOSFODNN7EXAMPLE"],
    [
      "aws-secret",
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ],
    [
      "pem",
      "x -----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY----- y",
      "MIIEow",
    ],
    ["basic-auth url", "connect https://admin:s3cr3tP4ss@db.example.com/x", "s3cr3tP4ss"],
    ["conn string", "Server=x;User Id=sa;Password=Hunter2Pass;Database=y", "Hunter2Pass"],
    ["anthropic", "ANTHROPIC=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["github", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ];
  it.each(cases)("%s", (_n, input, secret) => {
    const out = r.redactString(input);
    expect(out).not.toContain(secret);
    expect(out).toMatch(MARK);
  });
  it("keeps non-secret text intact", () => {
    expect(r.redactString("GET /api/products?page=2 200 13ms")).toBe("GET /api/products?page=2 200 13ms");
    expect(r.redactString("https://example.com/path")).toBe("https://example.com/path");
  });
  it("entropy rule near key-like names only", () => {
    const tok = "Zq8xL2pV9mR4tY7wK1nB5cH3";
    expect(shannonEntropy(tok)).toBeGreaterThanOrEqual(4);
    expect(r.redactString(`api_token=${tok}`)).not.toContain(tok);
    expect(r.redactString(`commit ${tok}`)).toContain(tok);
    expect(r.redactString("session_key=aaaaaaaaaaaaaaaaaaaaaaaa")).toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
  });
  it("same value → same marker (correlatable)", () => {
    expect(redactionMarker("abc")).toBe(redactionMarker("abc"));
    expect(redactionMarker("abc")).not.toBe(redactionMarker("abd"));
  });
  it("exact secrets from config", () => {
    const rr = createRedactor({ secrets: ["plain-password-1"] });
    rr.addSecret("other-secret-2");
    const out = rr.redactString("a plain-password-1 b other-secret-2 c");
    expect(out).not.toContain("plain-password-1");
    expect(out).not.toContain("other-secret-2");
  });
  it("custom patterns", () => {
    const rr = createRedactor({ patterns: [/ACME-[0-9]{6}/] });
    expect(rr.redactString("id ACME-123456")).toMatch(MARK);
  });
  it("property: registered secrets never appear in output", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 4, maxLength: 40 }), fc.string(), fc.string(), (secret, pre, post) => {
        const rr = createRedactor({ secrets: [secret] });
        const out = rr.redactString(`${pre}${secret}${post}`);
        expect(out.includes(secret)).toBe(false);
      }),
    );
  });
  it("property: never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(typeof r.redactString(s)).toBe("string");
      }),
    );
  });
});

describe("redactHeaders / redactObject", () => {
  it("headers by name, case-insensitive", () => {
    const h = r.redactHeaders({ Authorization: "Basic dXNlcjpwYXNz", "X-Request-Id": "abc", "set-cookie": ["a=1", "b=2"] });
    expect(h.Authorization).toMatch(MARK);
    expect(h["X-Request-Id"]).toBe("abc");
    expect((h["set-cookie"] as string[]).every((x) => MARK.test(x))).toBe(true);
  });
  it("deep objects, sensitive keys, cycles, arrays", () => {
    const o: Record<string, unknown> = {
      user: "bob",
      password: "hunter2",
      nested: { apiKey: "k1", list: ["Bearer abcdefghijkl", 3], when: new Date(0) },
    };
    o.self = o;
    const out = r.redactObject(o) as Record<string, any>;
    expect(out.user).toBe("bob");
    expect(out.password).toMatch(MARK);
    expect(out.nested.apiKey).toMatch(MARK);
    expect(out.nested.list[0]).not.toContain("abcdefghijkl");
    expect(out.nested.list[1]).toBe(3);
    expect(out.nested.when).toBe("1970-01-01T00:00:00.000Z");
    expect(out.self).toBe("[Circular]");
    expect(o.password).toBe("hunter2"); // input untouched
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });
  it("deeply nested input does not overflow the stack", () => {
    let o: Record<string, unknown> = { token: "deep-secret" };
    for (let i = 0; i < 20_000; i++) o = { child: o };
    expect(() => r.redactObject(o)).not.toThrow();
  });
});

describe("logger", () => {
  it("redacts messages and data, filters by level", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", json: true, write: (l) => lines.push(l) });
    log.debug("hidden");
    log.info("auth Bearer abcdefghijklmnop", { password: "hunter2", n: 1 });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] as string);
    expect(rec.msg).not.toContain("abcdefghijklmnop");
    expect(rec.password).toMatch(MARK);
    expect(rec.n).toBe(1);
    expect(rec.level).toBe("info");
  });
  it("text mode + child bindings", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "trace", write: (l) => lines.push(l) }).child({ engine: "performance" });
    log.warn("slow", { p95: 12 });
    expect(lines[0]).toMatch(/^WARN {2}slow engine=performance p95=12\n$/);
  });
  it("memory logger and silent logger", () => {
    const m = createMemoryLogger();
    m.child({ a: 1 }).error("boom");
    expect(m.records[0]).toMatchObject({ level: "error", msg: "boom", a: 1 });
    expect(() => silentLogger.child({}).info("x")).not.toThrow();
    expect(createLogger({ level: "silent" })).toBe(silentLogger);
  });
  it("never throws even if the sink throws", () => {
    const log = createLogger({
      write: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => log.error("x")).not.toThrow();
  });
});

describe("camelCase sensitive keys (sw-coverage wave 5)", () => {
  it("accessToken / refreshToken / idToken / userPassword / sessionId are redacted; look-alikes are not", () => {
    const r = createRedactor({});
    const out = r.redactObject({
      accessToken: "8f14e45fceea167a5a36dedd4bea2543",
      refreshToken: "rt-1234",
      idToken: "x",
      userPassword: "letmein1",
      sessionId: "s1",
      tokenCount: "5",
      maxTokens: "100",
      author: "bob",
      authorId: "a1",
    }) as Record<string, string>;
    for (const k of ["accessToken", "refreshToken", "idToken", "userPassword", "sessionId"]) expect(out[k], k).toMatch(/^«redacted:/);
    expect(out).toMatchObject({ tokenCount: "5", maxTokens: "100", author: "bob", authorId: "a1" });
  });
});
