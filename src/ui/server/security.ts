/**
 * Security of the local UI server (docs/11-safety-security-privacy.md "Local UI server").
 * The server can start load tests and fault injection, so a web page the user happens to have open must
 * not be able to drive it:
 * - it listens on 127.0.0.1 only;
 * - every /api request needs the per-start session token (Authorization: Bearer, or ?t= for EventSource,
 *   which cannot send headers). The token travels in the URL fragment, which browsers never send;
 * - the Host header must name the loopback origin (blocks DNS rebinding: a hostile domain re-pointed at
 *   127.0.0.1 still sends its own name);
 * - a state-changing request with an Origin header must come from the UI's own origin; no CORS headers;
 * - strict CSP and no-sniff on every response.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export function setSecurityHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

/** Host header check: exactly the loopback origin we listen on. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** Origin check for state-changing requests: absent (same-origin fetch may omit it) or our own origin. */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  const o = origin.toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Token from `Authorization: Bearer <t>` or, for EventSource only, `?t=<t>`. */
export function tokenOk(req: IncomingMessage, url: URL, token: string, allowQuery: boolean): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return sameSecret(auth.slice(7).trim(), token);
  if (allowQuery) {
    const t = url.searchParams.get("t");
    if (t) return sameSecret(t, token);
  }
  return false;
}
