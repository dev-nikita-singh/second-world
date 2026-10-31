/**
 * Minimal HTTP layer on node:http: a method + path-pattern router, JSON body parsing with a size
 * limit, RealWorld-style error bodies `{ "errors": { "<field>": ["<message>"] } }`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly errors: Record<string, string[]>;
  constructor(status: number, field: string, message: string) {
    super(`${field} ${message}`);
    this.status = status;
    this.errors = { [field]: [message] };
  }
}

export const badRequest = (field: string, message: string) => new HttpError(400, field, message);
export const invalid = (field: string, message: string) => new HttpError(422, field, message);
export const unauthorized = () => new HttpError(401, "token", "is missing or invalid");
export const forbidden = (what: string) => new HttpError(403, what, "is not yours");
export const notFound = (what: string) => new HttpError(404, what, "not found");
export const conflict = (field: string) => new HttpError(409, field, "has already been taken");

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

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler): this {
    return this.add("GET", p, h);
  }
  post(p: string, h: Handler): this {
    return this.add("POST", p, h);
  }
  put(p: string, h: Handler): this {
    return this.add("PUT", p, h);
  }
  delete(p: string, h: Handler): this {
    return this.add("DELETE", p, h);
  }

  /** First route whose literal segments match; literal routes are registered before `:param` ones. */
  match(
    method: string,
    path: string,
  ): { handler: Handler; params: Record<string, string> } | "method-not-allowed" | undefined {
    const parts = path.split("/").filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = r.segments[i] as string;
        const part = parts[i] as string;
        if (seg.startsWith(":")) {
          let value: string;
          try {
            value = decodeURIComponent(part);
          } catch {
            ok = false;
            break;
          }
          params[seg.slice(1)] = value;
        } else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { handler: r.handler, params };
    }
    return pathMatched ? "method-not-allowed" : undefined;
  }
}

const MAX_BODY = 100 * 1024;

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body", "is too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return undefined;
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!type.startsWith("application/json")) throw badRequest("body", "must be application/json");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest("body", "is not valid JSON");
  }
}

export function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendError(res: ServerResponse, e: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // Drop headers a handler may already have set (e.g. Content-Location) before replying.
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  if (e instanceof HttpError) send(res, e.status, { errors: e.errors });
  else send(res, 500, { errors: { server: ["internal error"] } });
}

// ------------------------------------------------------------------ input validation

/** `obj[key]` must be an object (the RealWorld `{ "user": { … } }` wrapper). */
export function wrapper(body: unknown, key: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw invalid("body", "must be a JSON object");
  const inner = (body as Record<string, unknown>)[key];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner))
    throw invalid(key, "must be an object");
  return inner as Record<string, unknown>;
}

export function str(
  o: Record<string, unknown>,
  key: string,
  opts: { required: boolean; min?: number; max: number; pattern?: RegExp },
): string | undefined {
  const v = o[key];
  if (v === undefined) {
    if (opts.required) throw invalid(key, "can't be blank");
    return undefined;
  }
  if (typeof v !== "string") throw invalid(key, "must be a string");
  if (v.length < (opts.min ?? 0)) throw invalid(key, `must be at least ${opts.min} characters`);
  if (v.length > opts.max) throw invalid(key, `must be at most ${opts.max} characters`);
  if (opts.pattern && !opts.pattern.test(v)) throw invalid(key, "is invalid");
  return v;
}

/** Optional integer query parameter within [min, max]. */
export function intParam(q: URLSearchParams, key: string, min: number, max: number, dflt: number): number {
  const raw = q.get(key);
  if (raw === null) return dflt;
  if (!/^-?\d+$/.test(raw)) throw invalid(key, "must be an integer");
  const n = Number(raw);
  if (n < min || n > max) throw invalid(key, `must be between ${min} and ${max}`);
  return n;
}
