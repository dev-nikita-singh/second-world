import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseOtlp } from "../../../src/adapters/telemetry/otlp.js";
import {
  decodeOtlpProtobuf,
  detectOtlpSignal,
  isOtlpProtobufFile,
  OtlpProtobufError,
  parseOtlpProtobuf,
} from "../../../src/adapters/telemetry/otlp-proto.js";
import { createFakeClock } from "../../../src/core/clock.js";
import { buildModel, type ModelData, toCanonicalJson } from "../../../src/engines/model/index.js";
import { withTmpDir } from "../../helpers/tmp.js";
import {
  encode,
  encodeMetricsRequest,
  encodeTraceRequest,
  type Field,
  varintBytes,
} from "./otlp-pb-encoder.js";

const FIX = path.resolve(__dirname, "../../fixtures/model");
const TRACE = "5b8efff798038103d269b633813fc60c";
const SPAN = "eee19b7ec3c1b174";
const PARENT = "00f067aa0ba902b7";

const tracePayload = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "shop" } }] },
      scopeSpans: [
        {
          scope: { name: "test-scope", version: "1.0" },
          spans: [
            {
              traceId: TRACE,
              spanId: SPAN,
              parentSpanId: PARENT,
              name: "GET /x",
              kind: 2,
              startTimeUnixNano: "1761700000000000000",
              endTimeUnixNano: "1761700000012345678",
              attributes: [
                { key: "s", value: { stringValue: "v" } },
                { key: "i", value: { intValue: "9007199254740993" } },
                { key: "neg", value: { intValue: "-5" } },
                { key: "d", value: { doubleValue: 1.5 } },
                { key: "b", value: { boolValue: true } },
                { key: "f", value: { boolValue: false } },
                { key: "bytes", value: { bytesValue: "AAEC" } },
                {
                  key: "arr",
                  value: {
                    arrayValue: {
                      values: [
                        { stringValue: "a" },
                        { intValue: "2" },
                        { arrayValue: { values: [{ boolValue: false }] } },
                      ],
                    },
                  },
                },
                {
                  key: "kv",
                  value: {
                    kvlistValue: {
                      values: [
                        { key: "k", value: { doubleValue: 0.25 } },
                        { key: "n", value: { kvlistValue: { values: [] } } },
                      ],
                    },
                  },
                },
                { key: "empty", value: {} },
              ],
              status: { code: 2, message: "boom" },
            },
            {
              traceId: TRACE,
              spanId: PARENT,
              name: "root",
              kind: 3,
              startTimeUnixNano: "1761699999999000000",
              endTimeUnixNano: "1761700000020000000",
              status: { code: 1 },
            },
          ],
        },
      ],
    },
  ],
};

const metricsPayload = {
  resourceMetrics: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "shop" } }] },
      scopeMetrics: [
        {
          scope: { name: "m" },
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
                      { key: "http.route", value: { stringValue: "/items" } },
                    ],
                    startTimeUnixNano: "1761700000000000000",
                    timeUnixNano: "1761700060000000000",
                    count: "10",
                    sum: 1.25,
                    bucketCounts: ["2", "5", "3"],
                    explicitBounds: [0.05, 0.2],
                  },
                ],
              },
            },
            {
              name: "requests",
              sum: {
                aggregationTemporality: 1,
                isMonotonic: true,
                dataPoints: [{ asInt: "-42", timeUnixNano: "1761700060000000000" }],
              },
            },
            { name: "temp", unit: "C", gauge: { dataPoints: [{ asDouble: 21.5 }] } },
            {
              name: "latency.summary",
              summary: {
                dataPoints: [
                  {
                    count: "4",
                    sum: 2,
                    quantileValues: [
                      { quantile: 0.5, value: 0.4 },
                      { quantile: 0.99, value: 0.9 },
                    ],
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

/** Decoder errors are always OtlpProtobufError (never RangeError/TypeError/crashes). */
function expectCleanError(fn: () => unknown, msg?: RegExp): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(OtlpProtobufError);
  if (msg) expect((err as Error).message).toMatch(msg);
}

describe("OTLP protobuf traces", () => {
  it("decodes every field the JSON path uses, identically to OTLP/JSON", () => {
    const pb = parseOtlpProtobuf(encodeTraceRequest(tracePayload));
    const json = parseOtlp(tracePayload);
    expect(pb.signal).toBe("traces");
    expect(pb.warnings).toEqual([]);
    expect(pb.spans).toEqual(json.spans);
    const s = pb.spans[0];
    expect(s).toMatchObject({
      traceId: TRACE,
      spanId: SPAN,
      parentSpanId: PARENT,
      name: "GET /x",
      kind: "server",
      startUs: 1761700000000000,
      endUs: 1761700000012345,
      status: "error",
      statusMessage: "boom",
      service: "shop",
      scope: "test-scope",
    });
    expect(s?.attributes).toEqual({
      s: "v",
      i: 9007199254740992,
      neg: -5,
      d: 1.5,
      b: true,
      f: false,
      bytes: "AAEC",
      arr: ["a", 2, [false]],
      kv: { k: 0.25, n: {} },
      empty: null,
    });
    expect(pb.spans[1]).toMatchObject({ kind: "client", status: "ok" });
    expect(pb.spans[1]?.parentSpanId).toBeUndefined();
  });

  it("decodes the shop + payments fixtures to the same spans as their JSON", () => {
    const shop = JSON.parse(readFileSync(path.join(FIX, "shop-traces.json"), "utf8"));
    expect(parseOtlpProtobuf(encodeTraceRequest(shop)).spans).toEqual(parseOtlp(shop).spans);
    const lines = readFileSync(path.join(FIX, "payments-traces.jsonl"), "utf8").split("\n").filter(Boolean);
    // Concatenated protobuf messages merge (repeated fields append), like JSONL lines.
    const bytes = Buffer.concat(lines.map((l) => Buffer.from(encodeTraceRequest(JSON.parse(l)))));
    expect(parseOtlpProtobuf(bytes).spans).toEqual(parseOtlp(lines.join("\n")).spans);
  });

  it("skips unknown fields of every wire type, and reads the deprecated instrumentation_library_spans (1000)", () => {
    const spanFields: Field[] = [
      { f: 99, t: "varint", v: 300 },
      { f: 1, t: "bytes", v: Buffer.from(TRACE, "hex") },
      { f: 2, t: "bytes", v: Buffer.from(SPAN, "hex") },
      { f: 50, t: "fixed32", v: 7 },
      { f: 5, t: "string", v: "op" },
      {
        f: 11,
        t: "msg",
        v: [
          { f: 1, t: "fixed64", v: 5n },
          { f: 2, t: "string", v: "event" },
        ],
      }, // events
      { f: 7, t: "fixed64", v: 2_000_000n },
      { f: 8, t: "fixed64", v: 5_000_000n },
      { f: 77, t: "double", v: 3.14 },
      { f: 9, t: "string", v: "" }, // attributes with an empty KeyValue
    ];
    const bytes = encode([
      {
        f: 1,
        t: "msg",
        v: [
          {
            f: 1000,
            t: "msg",
            v: [
              { f: 1, t: "msg", v: [{ f: 1, t: "string", v: "legacy-lib" }] },
              { f: 2, t: "msg", v: spanFields },
            ],
          },
          { f: 42, t: "msg", v: [{ f: 1, t: "string", v: "unknown" }] },
        ],
      },
    ]);
    const r = parseOtlpProtobuf(bytes);
    expect(r.spans).toHaveLength(1);
    expect(r.spans[0]).toMatchObject({
      name: "op",
      startUs: 2000,
      endUs: 5000,
      scope: "legacy-lib",
      service: "unknown_service",
    });
  });

  it("spans missing ids are skipped with a warning, like JSON", () => {
    const r = parseOtlpProtobuf(
      encode([
        {
          f: 1,
          t: "msg",
          v: [
            {
              f: 2,
              t: "msg",
              v: [
                {
                  f: 2,
                  t: "msg",
                  v: [
                    { f: 5, t: "string", v: "noid" },
                    { f: 7, t: "fixed64", v: 1n },
                  ],
                },
              ],
            },
          ],
        },
      ]),
      { signal: "traces" },
    );
    expect(r.spans).toEqual([]);
    expect(r.warnings[0]).toContain("noid");
  });

  it("bounds kept spans with maxSpans (rest skipped undecoded, counted as dropped)", () => {
    const shop = JSON.parse(readFileSync(path.join(FIX, "shop-traces.json"), "utf8"));
    const total = parseOtlp(shop).spans.length;
    const r = parseOtlpProtobuf(encodeTraceRequest(shop), { maxSpans: 5 });
    expect(r.spans).toHaveLength(5);
    expect(r.droppedSpans).toBe(total - 5);
  });
});

describe("OTLP protobuf metrics", () => {
  it("decodes histogram (packed), sum (sfixed64 asInt), gauge, summary like OTLP/JSON", () => {
    const pb = parseOtlpProtobuf(encodeMetricsRequest(metricsPayload));
    expect(pb.signal).toBe("metrics");
    expect(pb.metrics).toEqual(parseOtlp(metricsPayload).metrics);
    expect(pb.metrics.map((m) => m.type)).toEqual(["histogram", "sum", "gauge", "summary"]);
    expect(pb.metrics[0]?.points[0]).toMatchObject({
      count: 10,
      sum: 1.25,
      bucketCounts: [2, 5, 3],
      explicitBounds: [0.05, 0.2],
    });
    expect(pb.metrics[1]).toMatchObject({ monotonic: true, temporality: "delta", points: [{ value: -42 }] });
  });

  it("accepts unpacked repeated fixed64/double too", () => {
    const pb = parseOtlpProtobuf(encodeMetricsRequest(metricsPayload, { packed: false }));
    expect(pb.metrics).toEqual(parseOtlp(metricsPayload).metrics);
  });

  it("decodes exponential histograms (count/sum; buckets skipped)", () => {
    const bytes = encode([
      {
        f: 1,
        t: "msg",
        v: [
          {
            f: 2,
            t: "msg",
            v: [
              {
                f: 2,
                t: "msg",
                v: [
                  { f: 1, t: "string", v: "exp" },
                  {
                    f: 10,
                    t: "msg",
                    v: [
                      {
                        f: 1,
                        t: "msg",
                        v: [
                          { f: 4, t: "fixed64", v: 6n },
                          { f: 5, t: "double", v: 3 },
                          { f: 6, t: "varint", v: 2 }, // scale
                          { f: 8, t: "msg", v: [{ f: 1, t: "varint", v: 1 }] }, // positive buckets
                        ],
                      },
                      { f: 2, t: "varint", v: 2 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const r = parseOtlpProtobuf(bytes);
    expect(r.metrics).toEqual([
      {
        name: "exp",
        unit: "",
        service: "unknown_service",
        resource: {},
        type: "exponentialHistogram",
        points: [{ attributes: {}, count: 6, sum: 3 }],
      },
    ]);
  });
});

describe("signal detection and file sniffing", () => {
  it("tells traces from metrics by the item layout", () => {
    expect(detectOtlpSignal(encodeTraceRequest(tracePayload))).toBe("traces");
    expect(detectOtlpSignal(encodeMetricsRequest(metricsPayload))).toBe("metrics");
    expect(detectOtlpSignal(new Uint8Array(0))).toBe("traces");
    expect(decodeOtlpProtobuf(new Uint8Array(0)).payload).toEqual({ resourceSpans: [] });
    // Explicit signal wins.
    expect(decodeOtlpProtobuf(encodeMetricsRequest(metricsPayload), { signal: "metrics" }).signal).toBe(
      "metrics",
    );
  });

  it("isOtlpProtobufFile: extension, then control bytes", () => {
    const pb = encodeTraceRequest(tracePayload);
    const json = Buffer.from(JSON.stringify(tracePayload, null, 2));
    expect(isOtlpProtobufFile("t.pb", json)).toBe(true);
    expect(isOtlpProtobufFile("t.json", pb)).toBe(false);
    expect(isOtlpProtobufFile("t.otlp", pb)).toBe(true);
    expect(isOtlpProtobufFile("t.otlp", json)).toBe(false);
    expect(isOtlpProtobufFile("t", Buffer.from('\n{"resourceSpans":[]}\r\n\t'))).toBe(false);
  });
});

describe("malformed, truncated and oversized input", () => {
  const good = encodeTraceRequest(tracePayload);

  it("every truncation either decodes a valid prefix or throws OtlpProtobufError", () => {
    let errors = 0;
    for (let n = 0; n < good.length; n++) {
      try {
        parseOtlpProtobuf(good.subarray(0, n), { signal: "traces" });
      } catch (e) {
        expect(e).toBeInstanceOf(OtlpProtobufError);
        errors++;
      }
    }
    expect(errors).toBeGreaterThan(good.length / 2);
    expectCleanError(() => parseOtlpProtobuf(good.subarray(0, good.length - 1)), /truncated/);
  });

  it("rejects invalid tags, wire types, groups and over-long varints", () => {
    expectCleanError(
      () => decodeOtlpProtobuf(Uint8Array.from([0x01, 0, 0, 0, 0, 0, 0, 0, 0])),
      /field number 0/,
    );
    expectCleanError(() => decodeOtlpProtobuf(Uint8Array.from([0x0b])), /groups/); // field 1, wire 3
    expectCleanError(() => decodeOtlpProtobuf(Uint8Array.from([0x0e])), /invalid wire type 6/);
    expectCleanError(() => decodeOtlpProtobuf(Uint8Array.from([0x0f])), /invalid wire type 7/);
    expectCleanError(
      () => decodeOtlpProtobuf(Uint8Array.from(Array(11).fill(0xff))),
      /varint longer than 10 bytes/,
    );
    expectCleanError(() => decodeOtlpProtobuf(Uint8Array.from([0x08, 0x80])), /truncated varint/);
    // Length prefix far beyond the buffer (and beyond 2^32).
    expectCleanError(
      () => decodeOtlpProtobuf(Uint8Array.from([0x0a, ...varintBytes(2n ** 40n), 1, 2])),
      /truncated/,
    );
    // Packed doubles whose length is not a multiple of 8.
    const badPacked = encode([
      {
        f: 1,
        t: "msg",
        v: [
          {
            f: 2,
            t: "msg",
            v: [
              {
                f: 2,
                t: "msg",
                v: [
                  { f: 1, t: "string", v: "h" },
                  {
                    f: 9,
                    t: "msg",
                    v: [{ f: 1, t: "msg", v: [{ f: 7, t: "bytes", v: new Uint8Array(5) }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expectCleanError(() => decodeOtlpProtobuf(badPacked, { signal: "metrics" }), /multiple of 8/);
  });

  it("enforces the size limit", () => {
    expectCleanError(() => decodeOtlpProtobuf(good, { maxBytes: 16 }), /exceeds the 16-byte limit/);
  });

  it("enforces the depth limit on deeply nested AnyValues (no stack overflow)", () => {
    let v: Field[] = [{ f: 1, t: "string", v: "leaf" }];
    for (let i = 0; i < 200; i++) v = [{ f: 5, t: "msg", v: [{ f: 1, t: "msg", v }] }];
    const span: Field[] = [
      { f: 1, t: "bytes", v: Buffer.from(TRACE, "hex") },
      { f: 2, t: "bytes", v: Buffer.from(SPAN, "hex") },
      { f: 7, t: "fixed64", v: 1n },
      {
        f: 9,
        t: "msg",
        v: [
          { f: 1, t: "string", v: "deep" },
          { f: 2, t: "msg", v },
        ],
      },
    ];
    const bytes = encode([{ f: 1, t: "msg", v: [{ f: 2, t: "msg", v: [{ f: 2, t: "msg", v: span }] }] }]);
    expectCleanError(() => parseOtlpProtobuf(bytes), /nesting deeper than 64 levels/);
    expect(parseOtlpProtobuf(bytes, { maxDepth: 1000 }).spans).toHaveLength(1);
  });

  it("random bytes never crash the decoder (deterministic fuzz)", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(rnd() * 64);
      const b = new Uint8Array(len);
      for (let j = 0; j < len; j++) b[j] = Math.floor(rnd() * 256);
      // Mutated valid messages too: flip one byte of a real request.
      const m = Uint8Array.from(good);
      m[Math.floor(rnd() * m.length)] = Math.floor(rnd() * 256);
      for (const input of [b, m]) {
        try {
          parseOtlpProtobuf(input);
        } catch (e) {
          expect(e).toBeInstanceOf(OtlpProtobufError);
        }
      }
    }
  });
});

describe("model round trip: protobuf and JSON give an identical model", () => {
  it("same shop + payments traces, as .otlp files with JSON vs protobuf content", async () => {
    await withTmpDir(async (tmp) => {
      const shop = JSON.parse(readFileSync(path.join(FIX, "shop-traces.json"), "utf8"));
      const lines = readFileSync(path.join(FIX, "payments-traces.jsonl"), "utf8").split("\n").filter(Boolean);
      const jsonDir = path.join(tmp.path, "json");
      const pbDir = path.join(tmp.path, "pb");
      await mkdir(jsonDir);
      await mkdir(pbDir);
      // Same relative names → same evidence origins; the content decides the decoder.
      await writeFile(path.join(jsonDir, "shop.otlp"), JSON.stringify(shop));
      await writeFile(path.join(jsonDir, "payments.otlp"), lines.join("\n"));
      await writeFile(path.join(jsonDir, "metrics.otlp"), JSON.stringify(metricsPayload));
      await writeFile(path.join(pbDir, "shop.otlp"), encodeTraceRequest(shop));
      await writeFile(
        path.join(pbDir, "payments.otlp"),
        Buffer.concat(lines.map((l) => Buffer.from(encodeTraceRequest(JSON.parse(l))))),
      );
      await writeFile(path.join(pbDir, "metrics.otlp"), encodeMetricsRequest(metricsPayload));
      const build = async (project: string) => {
        const r = await buildModel(
          {
            project,
            serviceName: "shop-express",
            architecture: false,
            config: { files: [], discover: false },
            traces: ["shop.otlp", "payments.otlp", "metrics.otlp"],
          },
          { clock: createFakeClock(Date.parse("2026-10-29T12:00:00Z")) },
        );
        expect(r.status).toBe("passed");
        return { data: r.data as ModelData, limitations: r.limitations };
      };
      const a = await build(jsonDir);
      const b = await build(pbDir);
      expect(a.data.nodes.length).toBeGreaterThan(3);
      expect(a.data.coverage.sources.traces).toBe(true);
      expect(a.data.traces?.spans).toBeGreaterThan(0);
      expect(toCanonicalJson(b.data)).toBe(toCanonicalJson(a.data));
      expect(b.limitations).toEqual(a.limitations);
    }, "sw-model-pb-");
  });

  it("an unreadable protobuf file becomes a clean MODEL_OTLP_UNREADABLE limitation", async () => {
    await withTmpDir(async (tmp) => {
      await writeFile(path.join(tmp.path, "bad.pb"), Uint8Array.from([0x0a, 0x7f, 0x01]));
      const r = await buildModel({
        project: tmp.path,
        architecture: false,
        config: { files: [], discover: false },
        traces: ["bad.pb"],
      });
      const l = r.limitations.find((x) => x.code === "MODEL_OTLP_UNREADABLE");
      expect(l?.message).toMatch(/^bad\.pb: OTLP protobuf: truncated/);
    }, "sw-model-pb-");
  });
});
