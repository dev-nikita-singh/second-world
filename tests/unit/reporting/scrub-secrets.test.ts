/**
 * Regression (sw-qa): the old optional-scheme regex backtracked and replaced the scheme word
 * ("authorization: [REDACTED] $SW_AUTH_USER"). Placeholders must survive intact; literal
 * credentials must never survive — in scrubSecrets and in every rendered format.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REPRO_AUTH_HINT, scrubHeaderValue, scrubSecrets } from "../../../src/engines/reporting/bugs.js";
import { renderReport } from "../../../src/engines/reporting/index.js";
import { makeBugsData, makeResult } from "../../fixtures/reports.js";

const KEEP: string[] = [
  `curl -H "authorization: $SW_AUTH_USER" http://h/`,
  `curl -H 'Authorization: $SW_AUTH_ADMIN' http://h/`,
  `curl -H "Authorization: Bearer $SW_AUTH_USER" http://h/`,
  `curl -H "authorization: Basic \${SW_AUTH_OTHER}" http://h/`,
  `curl -H 'Proxy-Authorization: $SW_AUTH_PROXY' http://h/`,
  `curl -H 'X-Api-Key: $SW_AUTH_SERVICE' http://h/`,
  `curl -H 'Cookie: $SW_AUTH_SESSION' http://h/`,
  `curl -u $SW_AUTH_BASIC http://h/`,
  `curl 'http://h/x?token=$SW_AUTH_TOKEN'`,
  `{"authorization": "$SW_AUTH_USER"}`,
];

const REDACT: [input: string, expected: string, secret: string][] = [
  [`-H 'Authorization: Bearer abc123xyz'`, `-H 'Authorization: Bearer [REDACTED]'`, "abc123xyz"],
  [`-H "authorization: Basic dXNlcjpwYXNz"`, `-H "authorization: Basic [REDACTED]"`, "dXNlcjpwYXNz"],
  [`-H 'Authorization: rawtoken987'`, `-H 'Authorization: [REDACTED]'`, "rawtoken987"],
  [`-H 'Authorization: Token tk_live_42'`, `-H 'Authorization: Token [REDACTED]'`, "tk_live_42"],
  [`-H 'Authorization: Digest username="u", response="r1hash"'`, `-H 'Authorization: Digest [REDACTED]'`, "r1hash"],
  // unquoted: the value runs to the end of the line (over-redaction is the safe side)
  [`Authorization: Bearer plain42 (log line)`, `Authorization: Bearer [REDACTED]`, "plain42"],
  [`-H 'authorization: Bearer $SW_AUTH_USER extra-literal'`, `-H 'authorization: Bearer [REDACTED]'`, "extra-literal"],
  [`-H 'x-api-key: k-9f8e7d'`, `-H 'x-api-key: [REDACTED]'`, "k-9f8e7d"],
  [`-H 'X-Auth-Token: xat-1'`, `-H 'X-Auth-Token: [REDACTED]'`, "xat-1"],
  [`-H 'Cookie: sid=s3cr3t; theme=dark'`, `-H 'Cookie: [REDACTED]'`, "s3cr3t"],
  [`curl -u alice:pa55 http://h/`, `curl -u [REDACTED] http://h/`, "pa55"],
  [`curl --user 'bob:pw2' http://h/`, `curl --user '[REDACTED]' http://h/`, "pw2"],
  [`curl 'http://h/x?a=1&token=abc999&b=2'`, `curl 'http://h/x?a=1&token=[REDACTED]&b=2'`, "abc999"],
  [`curl 'http://h/x?access_token=at-77'`, `curl 'http://h/x?access_token=[REDACTED]'`, "at-77"],
  [`{"authorization": "Bearer jsonsecret1"}`, `{"authorization": "Bearer [REDACTED]"}`, "jsonsecret1"],
];

describe("scrubSecrets — table", () => {
  it.each(KEEP)("keeps placeholder intact: %s", (s) => {
    expect(scrubSecrets(s)).toBe(s);
  });

  it("the sw-qa case: scheme word never replaced next to a placeholder", () => {
    expect(scrubSecrets(`-H "authorization: $SW_AUTH_USER"`)).not.toContain("[REDACTED]");
    expect(scrubSecrets(`-H "Authorization: Bearer $SW_AUTH_USER"`)).toBe(`-H "Authorization: Bearer $SW_AUTH_USER"`);
  });

  it.each(REDACT)("redacts %s", (input, expected, secret) => {
    const out = scrubSecrets(input);
    expect(out).toBe(expected);
    if (secret) expect(out).not.toContain(secret);
  });

  it("scrubHeaderValue keeps surrounding whitespace", () => {
    expect(scrubHeaderValue("authorization", " Bearer abc ")).toBe(" Bearer [REDACTED] ");
    expect(scrubHeaderValue("authorization", "$SW_AUTH_USER ")).toBe("$SW_AUTH_USER ");
  });
});

describe("scrubSecrets — every rendered format", () => {
  const data = makeBugsData();
  data.reproductions["fp-bola"]!.curl = [
    `curl -sS -X GET 'http://127.0.0.1:3000/orders/ord_1' -H "authorization: $SW_AUTH_OTHER"`,
    `curl -sS -X GET 'http://127.0.0.1:3000/orders/ord_1' -H "authorization: Bearer leakedtoken42"`,
  ];
  const result = makeResult({ engine: "bugs", data });

  it.each(["tty", "md", "html"] as const)("%s keeps the placeholder header whole and redacts the literal one", (fmt) => {
    const out = renderReport([result], fmt, { color: false });
    expect(out).not.toContain("leakedtoken42");
    expect(out).not.toMatch(/\[REDACTED\]\s*\$SW_AUTH/);
    const placeholder = fmt === "html" ? "authorization: $SW_AUTH_OTHER&quot;" : 'authorization: $SW_AUTH_OTHER"';
    expect(out).toContain(placeholder);
    expect(out).toContain(fmt === "html" ? "authorization: Bearer [REDACTED]&quot;" : 'authorization: Bearer [REDACTED]"');
  });

  it("hint text tells users the env var holds the full header value", () => {
    expect(REPRO_AUTH_HINT).toContain("export SW_AUTH_<ROLE>='<full header value, e.g. Bearer …>'");
    expect(renderReport([result], "tty", { color: false })).toContain(REPRO_AUTH_HINT);
  });
});

describe("scrubSecrets — property", () => {
  const token = fc.stringMatching(/^[A-Za-z0-9._~+\/-]{6,40}$/).map((t) => `zq${t}`); // prefix: never a scheme word or placeholder
  const role = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,12}$/);
  const scheme = fc.constantFrom("", "Bearer ", "bearer ", "Basic ", "Token ", "Digest ");
  const header = fc.constantFrom("authorization", "Authorization", "AUTHORIZATION", "proxy-authorization", "x-api-key", "Cookie", "X-Auth-Token");
  const quote = fc.constantFrom(`'`, `"`);

  it("generated literal tokens never survive", () => {
    fc.assert(
      fc.property(header, scheme, token, quote, (h, sc, tok, q) => {
        const line = `curl -sS -X POST 'http://127.0.0.1:1/x' -H ${q}${h}: ${sc}${tok}${q} --data '{}'`;
        expect(scrubSecrets(line)).not.toContain(tok);
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(token, token, (user, pass) => {
        expect(scrubSecrets(`curl -u ${user}:${pass} http://h/`)).not.toContain(pass);
        expect(scrubSecrets(`curl 'http://h/?token=${encodeURIComponent(pass)}'`)).not.toContain(encodeURIComponent(pass));
      }),
      { numRuns: 200 },
    );
  });

  it("$SW_AUTH_<ROLE> placeholders always survive, with their scheme word", () => {
    fc.assert(
      fc.property(header, scheme, role, quote, fc.boolean(), (h, sc, r, q, braces) => {
        const ph = braces ? `\${SW_AUTH_${r}}` : `$SW_AUTH_${r}`;
        // a scheme only makes sense for authorization headers
        const value = /authorization/i.test(h) ? `${sc}${ph}` : ph;
        const line = `curl -H ${q}${h}: ${value}${q} http://h/`;
        expect(scrubSecrets(line)).toBe(line);
      }),
      { numRuns: 300 },
    );
  });
});
