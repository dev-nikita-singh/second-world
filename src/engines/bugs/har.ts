/**
 * HAR 1.2 export of a reproduction (docs/03-engines/api-bug-hunter.md §3 step 2: "record full
 * request/response (redacted) as a HAR-like artifact"). Written as `reproduction.har` next to
 * the JSON reproduction artifact.
 *
 * Credentials follow the curl convention exactly: the role's credential header carries the
 * placeholder `$SW_AUTH_<ROLE>` (env var holding the full header value), never a token. Cookies,
 * other auth-like headers and secret-looking query parameters are replaced by "[REDACTED]", URL
 * userinfo is dropped, and the whole document is passed through the session redactor last.
 * Spec: http://www.softwareishard.com/blog/har-12-spec/
 */
import { STATUS_CODES } from "node:http";
import type { Redactor } from "../../core/log/redact.js";
import { BugsHttp, type Exchange, ROLE_EXPIRED, ROLE_INVALID } from "./http.js";
import type { Credential } from "./schema.js";

export const HAR_REDACTED = "[REDACTED]";
const SENSITIVE_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token)$|token|secret|password|session/i;
const SENSITIVE_PARAM = /token|secret|password|passwd|api[-_]?key|apikey|signature|sig$|session|auth/i;

export interface HarNameValue {
  name: string;
  value: string;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: HarNameValue[];
    headers: HarNameValue[];
    queryString: HarNameValue[];
    postData?: { mimeType: string; params: HarNameValue[]; text: string };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: HarNameValue[];
    headers: HarNameValue[];
    content: { size: number; mimeType: string; text?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
    _error?: string;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  comment?: string;
}

export interface Har {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    entries: HarEntry[];
    comment?: string;
  };
}

export interface HarOptions {
  roles: Record<string, Credential>;
  /** Wall-clock ISO time of the first request (reports only). */
  startedIso: string;
  redactor?: Redactor;
  creatorVersion?: string;
  comment?: string;
  /** Max entries (default 256). */
  maxEntries?: number;
}

function credentialHeaderName(cred: Credential | undefined): string {
  return cred?.type === "header" ? cred.name.toLowerCase() : "authorization";
}

function cleanUrl(raw: string): { url: string; query: HarNameValue[] } {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    const query: HarNameValue[] = [];
    for (const [k, v] of [...u.searchParams.entries()]) {
      const value = SENSITIVE_PARAM.test(k) ? HAR_REDACTED : v;
      query.push({ name: k, value });
      if (value !== v) u.searchParams.set(k, value);
    }
    return { url: u.toString(), query };
  } catch {
    return { url: raw, query: [] };
  }
}

/** Builds a HAR 1.2 document from recorded exchanges (already redacted bodies). */
export function toHar(exchanges: readonly Exchange[], o: HarOptions): Har {
  const list = exchanges.filter((e) => !e.blocked).slice(0, o.maxEntries ?? 256);
  const t0 = list.reduce((m, e) => Math.min(m, e.tStart), Infinity);
  const base = Date.parse(o.startedIso);
  const entries: HarEntry[] = list.map((e) => {
    const role = e.role;
    const cred = typeof role === "string" ? o.roles[role] : undefined;
    const credHeader = credentialHeaderName(cred);
    const reqHeaders: HarNameValue[] = Object.entries(e.requestHeaders).map(([k, v]) => {
      const name = k.toLowerCase();
      if (cred && name === credHeader) return { name, value: `$${BugsHttp.authEnvName(role)}` };
      if (name === "authorization" && (role === ROLE_INVALID || role === ROLE_EXPIRED))
        return { name, value: HAR_REDACTED };
      if (SENSITIVE_HEADER.test(name)) return { name, value: HAR_REDACTED };
      return { name, value: String(v) };
    });
    const resHeaders: HarNameValue[] = Object.entries(e.responseHeaders).map(([k, v]) => ({
      name: k.toLowerCase(),
      value: SENSITIVE_HEADER.test(k) ? HAR_REDACTED : String(v),
    }));
    const { url, query } = cleanUrl(e.url);
    const reqCt = e.requestHeaders["content-type"] ?? "application/octet-stream";
    const time = Math.max(0, Math.round((e.tEnd - e.tStart) * 1000) / 1000);
    const entry: HarEntry = {
      startedDateTime: new Date(
        (Number.isFinite(base) ? base : 0) + (Number.isFinite(t0) ? e.tStart - t0 : 0),
      ).toISOString(),
      time,
      request: {
        method: e.method,
        url,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: reqHeaders,
        queryString: query,
        headersSize: -1,
        bodySize: e.requestBody === undefined ? 0 : Buffer.byteLength(e.requestBody),
      },
      response: {
        status: e.status,
        statusText: STATUS_CODES[e.status] ?? "",
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: resHeaders,
        content: {
          size: e.responseBody === undefined ? 0 : Buffer.byteLength(e.responseBody),
          mimeType: e.contentType || "x-unknown",
          ...(e.responseBody === undefined ? {} : { text: e.responseBody }),
        },
        redirectURL: e.responseHeaders.location ?? "",
        headersSize: -1,
        bodySize: e.responseBody === undefined ? (e.error ? -1 : 0) : Buffer.byteLength(e.responseBody),
        ...(e.error ? { _error: e.error } : {}),
      },
      cache: {},
      timings: { send: 0, wait: time, receive: 0 },
    };
    if (e.requestBody !== undefined)
      entry.request.postData = { mimeType: reqCt, params: [], text: e.requestBody };
    if (e.operation) entry.comment = e.operation;
    return entry;
  });
  const har: Har = {
    log: {
      version: "1.2",
      creator: { name: "second-world", version: o.creatorVersion ?? "0.1.0" },
      entries,
      ...(o.comment ? { comment: o.comment } : {}),
    },
  };
  if (!o.redactor) return har;
  // Final pass: configured secrets anywhere in bodies/URLs. Placeholders are not secrets.
  return o.redactor.redactObject(har);
}
