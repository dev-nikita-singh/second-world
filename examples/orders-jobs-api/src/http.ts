/**
 * Minimal HTTP layer on node:http: a regex route table, JSON bodies with a size limit, and
 * `{ "error": { "code", "message" } }` error bodies.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const invalid = (message: string) => new HttpError(422, "invalid", message);
export const unauthorized = () => new HttpError(401, "unauthorized", "missing or invalid bearer token");
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);

export interface Request {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  /** Parsed JSON body (undefined when there is none). */
  body: unknown;
}

export type Handler = (req: Request, res: ServerResponse) => Promise<void>;

export interface Route {
  method: string;
  /** Anchored path regex; named groups become `req.params`. */
  pattern: RegExp;
  handler: Handler;
}

/** First route whose pattern matches; "method-not-allowed" when only the method differs. */
export function match(
  routes: readonly Route[],
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | "method-not-allowed" | undefined {
  let pathMatched = false;
  for (const route of routes) {
    const m = route.pattern.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (route.method === method) return { route, params: { ...(m.groups ?? {}) } };
  }
  return pathMatched ? "method-not-allowed" : undefined;
}

const MAX_BODY = 64 * 1024;

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large", "body is too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return undefined;
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!type.startsWith("application/json")) throw badRequest("body must be application/json");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest("body is not valid JSON");
  }
}

export function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void {
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

export function sendError(res: ServerResponse, e: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (e instanceof HttpError) send(res, e.status, { error: { code: e.code, message: e.message } }, e.headers);
  else send(res, 500, { error: { code: "internal", message: "internal error" } });
}

// ------------------------------------------------------------------ input validation

export function object(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalid(`${what} must be a JSON object`);
  return v as Record<string, unknown>;
}

export function str(
  o: Record<string, unknown>,
  key: string,
  opts: { required: boolean; min?: number; max: number; pattern?: RegExp },
): string | undefined {
  const v = o[key];
  if (v === undefined) {
    if (opts.required) throw invalid(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw invalid(`${key} must be a string`);
  // Lengths in code points (JSON Schema minLength/maxLength), not UTF-16 units.
  const len = [...v].length;
  if (len < (opts.min ?? 0)) throw invalid(`${key} must have at least ${opts.min} characters`);
  if (len > opts.max) throw invalid(`${key} must have at most ${opts.max} characters`);
  if (opts.pattern && !opts.pattern.test(v)) throw invalid(`${key} is invalid`);
  return v;
}

export function int(
  o: Record<string, unknown>,
  key: string,
  opts: { required: boolean; min: number; max: number },
): number | undefined {
  const v = o[key];
  if (v === undefined) {
    if (opts.required) throw invalid(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) throw invalid(`${key} must be an integer`);
  if (v < opts.min || v > opts.max) throw invalid(`${key} must be between ${opts.min} and ${opts.max}`);
  return v;
}

/** Optional integer query parameter within [min, max]. */
export function intParam(q: URLSearchParams, key: string, min: number, max: number, dflt: number): number {
  const raw = q.get(key);
  if (raw === null) return dflt;
  if (!/^-?\d{1,12}$/.test(raw)) throw invalid(`${key} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max) throw invalid(`${key} must be between ${min} and ${max}`);
  return n;
}

/** Optional boolean query parameter ("true" / "false"). */
export function boolParam(q: URLSearchParams, key: string): boolean {
  const raw = q.get(key);
  if (raw === null || raw === "false") return false;
  if (raw === "true") return true;
  throw invalid(`${key} must be true or false`);
}

/** Path id: a positive integer that fits in SQLite (else 404, like any unknown id). */
export function idParam(raw: string | undefined, what: string): number {
  if (raw === undefined || !/^[1-9]\d{0,12}$/.test(raw)) throw notFound(what);
  return Number(raw);
}
