/**
 * Property-based fuzzing of secret redaction (docs/11 §4, threat model I1–I3).
 *
 * Generated secrets are placed next to sensitive names in every casing (camelCase, snake_case,
 * kebab-case, UPPER, Pascal, prefixed) and in every textual context a writer produces: JSON text,
 * pretty JSON, query strings, form bodies, YAML-ish lines, header lines (Cookie, Set-Cookie,
 * Authorization, X-Api-Key), basic-auth URLs. Property: the secret (raw or URL-encoded) never
 * survives the redactor, nor any writer built on it: logger (text + JSON), audit log (memory + file),
 * HAR, and objects (redactObject).
 *
 * Before the wave-8 fix the redactor leaked short values in free text (`{"password":"hunter2"}`,
 * `?access_token=abc123`), quoted values with spaces, `Cookie: sid=…` lines and keys such as
 * secretKey / SECRET_KEY / signingKey / passphrase.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../../src/core/log/logger.js";
import { createRedactor } from "../../../src/core/log/redact.js";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import { toHar } from "../../../src/engines/bugs/har.js";
import type { Exchange } from "../../../src/engines/bugs/http.js";
import { makeTmpDir } from "../../helpers/tmp.js";

const NUM_RUNS = Number(process.env.SW_FUZZ_RUNS ?? 1500);
const SEED = process.env.SW_FUZZ_SEED ? Number(process.env.SW_FUZZ_SEED) : 0x5ec_0b0b;
const fcOpts = { numRuns: NUM_RUNS, seed: SEED };

const WORDS = [
  ["password"],
  ["passwd"],
  ["pwd"],
  ["passphrase"],
  ["secret"],
  ["token"],
  ["jwt"],
  ["api", "key"],
  ["apikey"],
  ["access", "token"],
  ["refresh", "token"],
  ["id", "token"],
  ["client", "secret"],
  ["private", "key"],
  ["secret", "key"],
  ["signing", "key"],
  ["access", "key"],
  ["session", "id"],
  ["session"],
  ["auth"],
  ["auth", "token"],
  ["credentials"],
  ["cookie"],
  ["authorization"],
  ["x", "api", "key"],
  ["x", "auth", "token"],
  ["csrf", "token"],
];

const cap = (w: string): string => (w[0] as string).toUpperCase() + w.slice(1);
const keyName = fc
  .tuple(
    fc.constantFrom(...WORDS),
    fc.constantFrom("snake", "camel", "kebab", "upper", "pascal"),
    fc.constantFrom("", "user", "db", "my"),
  )
  .map(([words, style, prefix]) => {
    const w = prefix ? [prefix, ...words] : [...words];
    switch (style) {
      case "camel":
        return w.map((x, i) => (i === 0 ? x : cap(x))).join("");
      case "pascal":
        return w.map(cap).join("");
      case "kebab":
        return w.join("-");
      case "upper":
        return w.join("_").toUpperCase();
      default:
        return w.join("_");
    }
  });

/** A secret: 8–40 chars, token-ish alphabet, never a placeholder-looking word. */
const secret = fc
  .stringMatching(/^[A-Za-z0-9][A-Za-z0-9._~+/!@#%^*-]{7,39}$/)
  .filter((s) => /[0-9]/.test(s) && /[A-Za-z]/.test(s));
/** Secrets with spaces (pass phrases) for quoted contexts. */
const phrase = fc
  .array(fc.stringMatching(/^[a-z0-9]{3,8}$/), { minLength: 2, maxLength: 4 })
  .map((ws) => `${ws.join(" ")} 9Z`);

type Ctx = (k: string, v: string) => string;
const CONTEXTS: Record<string, Ctx> = {
  json: (k, v) => JSON.stringify({ user: "alice", [k]: v, n: 1 }),
  jsonPretty: (k, v) => JSON.stringify({ data: { [k]: v } }, null, 2),
  jsonSpaced: (k, v) => `{ "${k}" : "${v}" }`,
  query: (k, v) => `http://127.0.0.1:3000/cb?x=1&${k}=${encodeURIComponent(v)}&y=2`,
  queryFirst: (k, v) => `/cb?${k}=${encodeURIComponent(v)}`,
  form: (k, v) => `a=1&${k}=${encodeURIComponent(v)}`,
  yaml: (k, v) => `${k}: '${v}'`,
  env: (k, v) =>
    `${k
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toUpperCase()
      .replace(/-/g, "_")}="${v}"`,
};
const HEADER_CONTEXTS: Record<string, (v: string) => string> = {
  cookie: (v) => `Cookie: theme=dark; sid=${v}`,
  setCookie: (v) => `Set-Cookie: sid=${v}; Path=/; HttpOnly`,
  bearer: (v) => `Authorization: Bearer ${v}`,
  apiKey: (v) => `x-api-key: ${v}`,
  curlH: (v) => `curl -H 'cookie: sid=${v}' http://127.0.0.1/`,
  basicUrl: (v) => `http://admin:${encodeURIComponent(v)}@127.0.0.1:3000/`,
};

function leaks(out: string, s: string): boolean {
  return (
    out.includes(s) || out.includes(encodeURIComponent(s)) || out.includes(JSON.stringify(s).slice(1, -1))
  );
}

describe("redaction fuzz: free text and objects (fast-check)", () => {
  const r = createRedactor();

  it("a secret next to a sensitive name never survives redactString, in any context", () => {
    fc.assert(
      fc.property(keyName, secret, fc.constantFrom(...Object.keys(CONTEXTS)), (k, v, ctx) => {
        const text = (CONTEXTS[ctx] as Ctx)(k, v);
        const out = r.redactString(text);
        expect(leaks(out, v), `${ctx}: ${text} → ${out}`).toBe(false);
        return true;
      }),
      fcOpts,
    );
  });

  it("quoted pass phrases with spaces are redacted whole", () => {
    fc.assert(
      fc.property(
        keyName,
        phrase,
        fc.constantFrom("json", "jsonPretty", "jsonSpaced", "yaml"),
        (k, v, ctx) => {
          const out = r.redactString((CONTEXTS[ctx] as Ctx)(k, v)).replace(/«redacted:[0-9a-f]{8}»/g, "«»");
          const around = (CONTEXTS[ctx] as Ctx)(k, "");
          for (const word of v.split(" "))
            if (word.length >= 3 && !around.includes(word))
              expect(out.includes(word), `${ctx} ${k} → ${out}`).toBe(false);
          return true;
        },
      ),
      fcOpts,
    );
  });

  it("credential header lines and basic-auth URLs never keep their value", () => {
    fc.assert(
      fc.property(secret, fc.constantFrom(...Object.keys(HEADER_CONTEXTS)), (v, ctx) => {
        const text = (HEADER_CONTEXTS[ctx] as (v: string) => string)(v);
        const out = r.redactString(text);
        expect(leaks(out, v), `${ctx}: ${text} → ${out}`).toBe(false);
        return true;
      }),
      fcOpts,
    );
  });

  it("redactObject: a sensitive key's string value is replaced at any depth", () => {
    fc.assert(
      fc.property(keyName, secret, fc.integer({ min: 0, max: 6 }), (k, v, depth) => {
        let o: unknown = { [k]: v };
        for (let i = 0; i < depth; i++) o = i % 2 ? { nested: o } : [o];
        expect(leaks(JSON.stringify(r.redactObject(o)), v)).toBe(false);
        return true;
      }),
      fcOpts,
    );
  });

  it("placeholders and markers are left alone (no double redaction)", () => {
    expect(r.redactString('-H "authorization: $SW_AUTH_USER"')).toBe('-H "authorization: $SW_AUTH_USER"');
    const envRef = "token=$" + "{SW_TOKEN}";
    expect(r.redactString(envRef)).toBe(envRef);
    const once = r.redactString('{"password":"hunter2"}');
    expect(r.redactString(once)).toBe(once);
    expect(r.redactString('{"auth": true, "token": null}')).toBe('{"auth": true, "token": null}');
  });
});

describe("redaction fuzz: writers (logger, audit log, HAR)", () => {
  it("logger (text and JSON) never prints a secret from the message or the data", () => {
    fc.assert(
      fc.property(
        keyName,
        secret,
        fc.constantFrom(...Object.keys(CONTEXTS)),
        fc.boolean(),
        (k, v, ctx, json) => {
          const lines: string[] = [];
          const log = createLogger({ level: "trace", json, write: (l) => lines.push(l) });
          const text = (CONTEXTS[ctx] as Ctx)(k, v);
          log.debug(`request ${text}`, { [k]: v, body: text, nested: { headers: { cookie: `sid=${v}` } } });
          log.child({ [k]: v }).info("child");
          expect(leaks(lines.join(""), v), lines.join("")).toBe(false);
          return true;
        },
      ),
      { ...fcOpts, numRuns: 400 },
    );
  });

  it("audit log (memory and file) never records a secret", async () => {
    const tmp = await makeTmpDir("sw-sec-audit-");
    try {
      const file = join(tmp.path, "audit.log");
      const g = createSafetyGuard({}, { interactive: false, auditFile: file });
      const seen: string[] = [];
      fc.assert(
        fc.property(keyName, secret, fc.constantFrom(...Object.keys(CONTEXTS)), (k, v, ctx) => {
          const text = (CONTEXTS[ctx] as Ctx)(k, v);
          g.audit({ action: "test", target: (CONTEXTS.query as Ctx)(k, v), detail: { [k]: v, text } });
          seen.push(v);
          return true;
        }),
        { ...fcOpts, numRuns: 200 },
      );
      const all = JSON.stringify(g.auditEntries()) + readFileSync(file, "utf8");
      for (const v of seen) expect(leaks(all, v), v).toBe(false);
    } finally {
      await tmp.cleanup();
    }
  });

  it("HAR: secrets in URLs, headers and bodies never reach the document", () => {
    const red = createRedactor();
    fc.assert(
      fc.property(keyName, secret, (k, v) => {
        const e: Exchange = {
          operation: "POST /login",
          method: "POST",
          url: (CONTEXTS.query as Ctx)(k, v),
          requestHeaders: { "content-type": "application/json", cookie: `sid=${v}`, "x-trace": "1" },
          requestBody: (CONTEXTS.json as Ctx)(k, v),
          status: 200,
          responseHeaders: { "set-cookie": `sid=${v}; Path=/`, "content-type": "application/json" },
          responseBody: JSON.stringify({ [k]: v, profile: { name: "a" } }),
          contentType: "application/json",
          durationMs: 1,
          tStart: 0,
          tEnd: 1,
          role: null,
          rateLimitedRetries: 0,
        };
        const har = JSON.stringify(
          toHar([e], { roles: {}, startedIso: "2026-11-01T00:00:00.000Z", redactor: red }),
        );
        expect(leaks(har, v), har).toBe(false);
        return true;
      }),
      { ...fcOpts, numRuns: 400 },
    );
  });
});
