/**
 * OTLP/HTTP protobuf ingestion end to end: POST application/x-protobuf to the built-in receiver
 * (traces + metrics, plain and gzip), protobuf responses, clean errors, and the model built from the
 * received spans equals the model built from the same traces as OTLP/JSON files.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../src/core/clock.js";
import {
  buildModel,
  type ModelData,
  parseOtlp,
  startOtlpReceiver,
  toCanonicalJson,
} from "../../../src/engines/model/index.js";
import { encode, encodeMetricsRequest, encodeTraceRequest } from "../../unit/model/otlp-pb-encoder.js";

const FIX = path.resolve(__dirname, "../../fixtures/model");
const SHOP = path.join(FIX, "shop-traces.json");
const PAYMENTS = path.join(FIX, "payments-traces.jsonl");

interface Reply {
  status: number;
  type: string;
  body: Buffer;
}

function post(url: string, body: Uint8Array | string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

const PB = { "content-type": "application/x-protobuf" };

/** Minimal google.rpc.Status reader: { code = 1 (varint), message = 2 (string) }. */
function rpcStatus(b: Buffer): { code: number; message: string } {
  let i = 0;
  let code = 0;
  let message = "";
  while (i < b.length) {
    const tag = b[i++] as number;
    if (tag === 0x08) code = b[i++] as number;
    else if (tag === 0x12) {
      const len = b[i++] as number; // test messages are < 128 bytes
      message = b.subarray(i, i + len).toString("utf8");
      i += len;
    } else break;
  }
  return { code, message };
}

describe("OTLP receiver — protobuf", () => {
  it("ingests protobuf traces + metrics and yields the same model as the JSON files", async () => {
    const shop = JSON.parse(readFileSync(SHOP, "utf8"));
    const lines = readFileSync(PAYMENTS, "utf8").split("\n").filter(Boolean);
    const rx = await startOtlpReceiver();
    try {
      const ok = await post(`${rx.url}/v1/traces`, encodeTraceRequest(shop), PB);
      expect(ok.status).toBe(200);
      expect(ok.type).toBe("application/x-protobuf");
      expect(ok.body.length).toBe(0); // empty ExportTraceServiceResponse
      for (const l of lines) {
        const r = await post(`${rx.url}/v1/traces`, gzipSync(encodeTraceRequest(JSON.parse(l))), {
          "content-type": "application/x-protobuf",
          "content-encoding": "gzip",
        });
        expect(r.status).toBe(200);
      }
      const metrics = {
        resourceMetrics: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "shop-express" } }] },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "http.server.request.duration",
                    unit: "s",
                    histogram: {
                      aggregationTemporality: 2,
                      dataPoints: [
                        {
                          attributes: [
                            { key: "http.request.method", value: { stringValue: "GET" } },
                            { key: "http.route", value: { stringValue: "/products" } },
                          ],
                          count: "4",
                          sum: 0.2,
                          bucketCounts: ["1", "3", "0"],
                          explicitBounds: [0.01, 0.1],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      const m = await post(`${rx.url}/v1/metrics`, encodeMetricsRequest(metrics), PB);
      expect(m.status).toBe(200);
      expect(m.body.length).toBe(0);

      const st = rx.stats();
      expect(st).toMatchObject({ traceRequests: 1 + lines.length, metricRequests: 1, rejected: 0 });
      const jsonSpans = [...parseOtlp(shop).spans, ...parseOtlp(lines.join("\n")).spans];
      expect(rx.spans()).toEqual(jsonSpans);
      expect(rx.metrics()).toEqual(parseOtlp(metrics).metrics);

      const opts = { clock: createFakeClock(Date.parse("2026-10-29T12:00:00Z")) };
      const base = {
        serviceName: "shop-express",
        architecture: false,
        config: { files: [], discover: false },
      };
      const fromPb = (
        await buildModel({ ...base, telemetry: { spans: rx.spans(), metrics: rx.metrics() } }, opts)
      ).data as ModelData;
      const fromJson = (
        await buildModel(
          { ...base, telemetry: { spans: jsonSpans, metrics: parseOtlp(metrics).metrics } },
          opts,
        )
      ).data as ModelData;
      expect(fromPb.coverage.sources.traces).toBe(true);
      expect(fromPb.coverage.sources.metrics).toBe(true);
      expect(toCanonicalJson(fromPb)).toBe(toCanonicalJson(fromJson));
    } finally {
      await rx.close();
    }
  });

  it("answers malformed, truncated and oversized protobuf with clean google.rpc.Status errors", async () => {
    const rx = await startOtlpReceiver({ maxBodyBytes: 4096 });
    try {
      const shop = JSON.parse(readFileSync(SHOP, "utf8"));
      const good = encodeTraceRequest({ resourceSpans: [shop.resourceSpans[0]] });

      const trunc = await post(`${rx.url}/v1/traces`, good.subarray(0, Math.min(good.length, 4000) - 3), PB);
      expect(trunc.status).toBe(400);
      expect(trunc.type).toBe("application/x-protobuf");
      expect(rpcStatus(trunc.body)).toEqual({ code: 3, message: expect.stringMatching(/truncated/) });

      const group = await post(`${rx.url}/v1/metrics`, Uint8Array.from([0x0b, 0x0c]), PB);
      expect(group.status).toBe(400);
      expect(rpcStatus(group.body).message).toMatch(/groups/);

      const big = await post(
        `${rx.url}/v1/traces`,
        encode([{ f: 1, t: "bytes", v: new Uint8Array(5000) }]),
        PB,
      );
      expect(big.status).toBe(413);
      expect(rpcStatus(big.body).code).toBe(8); // RESOURCE_EXHAUSTED

      const plain = await post(`${rx.url}/v1/traces`, "hello", { "content-type": "text/plain" });
      expect(plain.status).toBe(415);
      expect(plain.body.toString()).toContain("application/x-protobuf");

      expect(rx.spans()).toEqual([]);
      expect(rx.stats().rejected).toBe(4);
      // Still healthy after the bad requests.
      const ok = await post(`${rx.url}/v1/traces`, encodeTraceRequest({ resourceSpans: [] }), PB);
      expect(ok.status).toBe(200);
    } finally {
      await rx.close();
    }
  });
});
