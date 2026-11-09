/** Local UI server request checks (src/ui/server/security.ts; docs/11 "Local UI server"). */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { exitMeaning } from "../../../../src/ui/server/jobs.js";
import {
  hostAllowed,
  newToken,
  originAllowed,
  SECURITY_HEADERS,
  tokenOk,
} from "../../../../src/ui/server/security.js";

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

describe("UI server security checks", () => {
  it("tokens are long and random", () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
  });

  it("Host must be the loopback origin on our port (DNS rebinding)", () => {
    expect(hostAllowed("127.0.0.1:4777", 4777)).toBe(true);
    expect(hostAllowed("localhost:4777", 4777)).toBe(true);
    expect(hostAllowed("LOCALHOST:4777", 4777)).toBe(true);
    for (const h of [
      undefined,
      "",
      "127.0.0.1",
      "127.0.0.1:4778",
      "evil.example:4777",
      "127.0.0.1.evil.example:4777",
      "[::1]:4777",
    ])
      expect(hostAllowed(h, 4777), String(h)).toBe(false);
  });

  it("Origin, when sent, must be ours", () => {
    expect(originAllowed(undefined, 4777)).toBe(true);
    expect(originAllowed("http://127.0.0.1:4777", 4777)).toBe(true);
    expect(originAllowed("http://localhost:4777", 4777)).toBe(true);
    for (const o of ["null", "http://evil.example", "http://127.0.0.1:4778", "https://127.0.0.1:4777"])
      expect(originAllowed(o, 4777), o).toBe(false);
  });

  it("token: Bearer header everywhere; ?t= only where allowed (EventSource)", () => {
    const t = newToken();
    const u = (q = "") => new URL(`http://127.0.0.1:1/api/x${q}`);
    expect(tokenOk(req({ authorization: `Bearer ${t}` }), u(), t, false)).toBe(true);
    expect(tokenOk(req({ authorization: `Bearer ${t}x` }), u(), t, false)).toBe(false);
    expect(tokenOk(req({ authorization: t }), u(), t, false)).toBe(false);
    expect(tokenOk(req({}), u(`?t=${t}`), t, false)).toBe(false);
    expect(tokenOk(req({}), u(`?t=${t}`), t, true)).toBe(true);
    expect(tokenOk(req({}), u("?t=nope"), t, true)).toBe(false);
    expect(tokenOk(req({}), u(), t, true)).toBe(false);
  });

  it("every response gets a strict CSP and no-sniff", () => {
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).not.toContain("unsafe");
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("exit code wording", () => {
  it("says what the code means, per test type", () => {
    expect(exitMeaning(0)).toMatch(/Passed/);
    expect(exitMeaning(1)).toMatch(/found problems/);
    expect(exitMeaning(5)).toMatch(/down/);
    expect(exitMeaning(130)).toBe("Stopped");
    expect(exitMeaning(70)).toMatch(/report/);
    expect(exitMeaning(undefined)).toMatch(/without/);
    expect(exitMeaning(1, { engine: "replay" })).toMatch(/Still reproduces/);
    expect(exitMeaning(0, { engine: "replay" })).toMatch(/fixed/);
    expect(exitMeaning(0, { dryRun: true })).toMatch(/nothing was sent/);
  });
});
