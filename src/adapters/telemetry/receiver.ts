/**
 * Minimal OTLP/HTTP receiver — docs/03-engines/system-model.md §1.
 * `POST /v1/traces`, `POST /v1/metrics` with `Content-Type: application/json` or
 * `application/x-protobuf` (gzip/deflate allowed). Protobuf requests get protobuf responses (an empty
 * Export*ServiceResponse on success, a google.rpc.Status on error), per the OTLP/HTTP spec.
 * Binds 127.0.0.1 on an ephemeral port by default. Memory is bounded (`maxSpans`, `maxMetrics`,
 * `maxBodyBytes`); the oldest spans are dropped first.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync, inflateSync } from "node:zlib";
import { type NormalizedMetric, type NormalizedSpan, parseOtlp } from "./otlp.js";
import { encodeRpcStatus, parseOtlpProtobuf } from "./otlp-proto.js";

export interface OtlpReceiverOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  maxSpans?: number;
  maxMetrics?: number;
  onSpans?: (spans: NormalizedSpan[]) => void;
  onMetrics?: (metrics: NormalizedMetric[]) => void;
}

export interface OtlpReceiverStats {
  requests: number;
  traceRequests: number;
  metricRequests: number;
  rejected: number;
  spans: number;
  metrics: number;
  droppedSpans: number;
  droppedMetrics: number;
  warnings: string[];
}

export interface OtlpReceiver {
  /** Base URL, e.g. `http://127.0.0.1:43123` (set OTEL_EXPORTER_OTLP_ENDPOINT to this). */
  url: string;
  port: number;
  spans(): NormalizedSpan[];
  metrics(): NormalizedMetric[];
  stats(): OtlpReceiverStats;
  clear(): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) tooLarge = true; // keep draining (so we can answer), stop buffering
      if (!tooLarge) chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) reject(Object.assign(new Error(`payload too large (> ${max} bytes)`), { status: 413 }));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

export function startOtlpReceiver(opts: OtlpReceiverOptions = {}): Promise<OtlpReceiver> {
  const maxBody = opts.maxBodyBytes ?? 16 * 1024 * 1024;
  const maxSpans = opts.maxSpans ?? 200_000;
  const maxMetrics = opts.maxMetrics ?? 50_000;
  let spans: NormalizedSpan[] = [];
  let metrics: NormalizedMetric[] = [];
  const st: OtlpReceiverStats = {
    requests: 0,
    traceRequests: 0,
    metricRequests: 0,
    rejected: 0,
    spans: 0,
    metrics: 0,
    droppedSpans: 0,
    droppedMetrics: 0,
    warnings: [],
  };
  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  const sendProto = (res: ServerResponse, status: number, error?: string) => {
    // Success: empty Export*ServiceResponse (zero bytes). Error: google.rpc.Status (3 = INVALID_ARGUMENT).
    const body = error === undefined ? new Uint8Array(0) : encodeRpcStatus(status === 413 ? 8 : 3, error);
    res.writeHead(status, { "content-type": "application/x-protobuf", "content-length": body.length });
    res.end(body);
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    st.requests++;
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "POST" || (path !== "/v1/traces" && path !== "/v1/metrics")) {
      st.rejected++;
      sendJson(res, 404, { error: "not found: use POST /v1/traces or /v1/metrics" });
      return;
    }
    const ct = String(req.headers["content-type"] ?? "").toLowerCase();
    const proto = ct.includes("protobuf");
    if (!proto && !ct.includes("json")) {
      st.rejected++;
      req.resume();
      sendJson(res, 415, { error: "expected Content-Type: application/json or application/x-protobuf" });
      return;
    }
    const send = (r: ServerResponse, status: number, body: { error?: string; partialSuccess?: object }) =>
      proto ? sendProto(r, status, body.error) : sendJson(r, status, body);
    let body: Buffer;
    try {
      body = await readBody(req, maxBody);
      const enc = String(req.headers["content-encoding"] ?? "").toLowerCase();
      if (enc === "gzip") body = gunzipSync(body, { maxOutputLength: maxBody });
      else if (enc === "deflate") body = inflateSync(body, { maxOutputLength: maxBody });
    } catch (e) {
      st.rejected++;
      const status = (e as { status?: number }).status ?? 400;
      if (!res.headersSent) send(res, status, { error: (e as Error).message });
      return;
    }
    let parsed: ReturnType<typeof parseOtlp>;
    try {
      parsed = proto
        ? parseOtlpProtobuf(body, { signal: path === "/v1/traces" ? "traces" : "metrics", maxBytes: maxBody })
        : parseOtlp(JSON.parse(body.toString("utf8")) as unknown);
    } catch (e) {
      st.rejected++;
      send(res, 400, { error: proto ? (e as Error).message : "invalid JSON" });
      return;
    }
    for (const w of parsed.warnings) if (st.warnings.length < 100) st.warnings.push(w);
    if (path === "/v1/traces") {
      st.traceRequests++;
      spans.push(...parsed.spans);
      st.spans += parsed.spans.length;
      if (spans.length > maxSpans) {
        const drop = spans.length - maxSpans;
        st.droppedSpans += drop;
        spans = spans.slice(drop);
      }
      if (parsed.spans.length > 0) opts.onSpans?.(parsed.spans);
      send(res, 200, { partialSuccess: {} });
    } else {
      st.metricRequests++;
      metrics.push(...parsed.metrics);
      st.metrics += parsed.metrics.length;
      if (metrics.length > maxMetrics) {
        const drop = metrics.length - maxMetrics;
        st.droppedMetrics += drop;
        metrics = metrics.slice(drop);
      }
      if (parsed.metrics.length > 0) opts.onMetrics?.(parsed.metrics);
      send(res, 200, { partialSuccess: {} });
    }
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
      resolve({
        url: `http://${host}:${addr.port}`,
        port: addr.port,
        spans: () => spans.slice(),
        metrics: () => metrics.slice(),
        stats: () => ({ ...st, warnings: st.warnings.slice() }),
        clear: () => {
          spans = [];
          metrics = [];
        },
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}
