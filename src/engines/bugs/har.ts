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
import {
  isSensitiveHeader,
  REDACTED_PLACEHOLDER,
  type Redactor,
  redactUrlParams,
} from "../../core/log/redact.js";
import { BugsHttp, type Exchange, ROLE_EXPIRED, ROLE_INVALID } from "./http.js";
import type { Credential } from "./schema.js";

/** Same placeholder and the same sensitive header/param rules as the curl reproductions (core/log/redact.ts). */
export const HAR_REDACTED = REDACTED_PLACEHOLDER;

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
  timings: HarTimings;
  comment?: string;
}

/**
 * HAR 1.2 timings (ms). -1 = does not apply / unknown. `connect` includes `ssl` (spec), so the
 * entry time is blocked + dns + connect + send + wait + receive over the non -1 fields.
 */
export interface HarTimings {
  blocked: number;
  dns: number;
  connect: number;
  ssl: number;
  send: number;
  wait: number;
  receive: number;
}

const r3 = (n: number): number => Math.round(Math.max(0, n) * 1000) / 1000;

/**
 * Maps recorded phases to HAR timings. `blocked` takes the rest of the request's wait (pool
 * queue, earlier redirect hops), so the non -1 fields (ssl excluded, it is inside connect) sum to
 * `time`. Entry time is the final attempt only (429 back-off retries are not in it). `send` is 0: undici exposes no "request fully written" event, so
 * writing the request is counted in `wait`. Without phases (transport error, injected executor)
 * the whole time is `wait`.
 */
export function harTimings(e: Pick<Exchange, "phases">, time: number): HarTimings {
  const ph = e.phases;
  if (!ph) return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: time, receive: 0 };
  const dns = ph.dnsMs === undefined ? -1 : r3(ph.dnsMs);
  const ssl = ph.tlsMs === undefined ? -1 : r3(ph.tlsMs);
  const connect =
    ph.tcpMs === undefined && ph.tlsMs === undefined ? -1 : r3((ph.tcpMs ?? 0) + (ph.tlsMs ?? 0));
  let wait = r3(ph.serverMs);
  let receive = r3(ph.transferMs);
  // Clock rounding can make the phases exceed the total by a few µs: trim receive, then wait.
  const over = wait + receive + Math.max(0, dns) + Math.max(0, connect) - time;
  if (over > 0) {
    const cut = Math.min(receive, over);
    receive = r3(receive - cut);
    wait = r3(wait - (over - cut));
  }
  const blocked = r3(time - Math.max(0, dns) - Math.max(0, connect) - wait - receive);
  return { blocked, dns, connect, ssl, send: 0, wait, receive };
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
  return redactUrlParams(raw);
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
      if (isSensitiveHeader(name)) return { name, value: HAR_REDACTED };
      return { name, value: String(v) };
    });
    const resHeaders: HarNameValue[] = Object.entries(e.responseHeaders).map(([k, v]) => ({
      name: k.toLowerCase(),
      value: isSensitiveHeader(k) ? HAR_REDACTED : String(v),
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
      timings: harTimings(e, time),
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
