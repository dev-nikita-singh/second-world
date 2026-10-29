/** Tiny JSON HTTP client for integration tests (global fetch, keep-alive). */

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  ms: number;
}

export interface ApiOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function api<T = any>(
  baseUrl: string,
  method: string,
  path: string,
  opts: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  const text = await res.text();
  let body: unknown = text;
  if ((res.headers.get("content-type") ?? "").includes("json") && text.length > 0) body = JSON.parse(text);
  return { status: res.status, headers: res.headers, body: body as T, ms: performance.now() - t0 };
}
