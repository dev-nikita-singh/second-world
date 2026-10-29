import { describe, expect, it } from "vitest";
import {
  anyValue,
  histogramQuantile,
  nanosToMicros,
  normalizeId,
  parseOtlp,
} from "../../../src/adapters/telemetry/otlp.js";
import {
  histogramSeries,
  parsePrometheus,
  promHistogramQuantile,
} from "../../../src/adapters/telemetry/prometheus.js";

const TRACE = "5b8efff798038103d269b633813fc60c";
const SPAN = "eee19b7ec3c1b174";

describe("OTLP/JSON parsing", () => {
  it("converts attribute values of every type", () => {
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "shop" } }] },
          scopeSpans: [
            {
              scope: { name: "test" },
              spans: [
                {
                  traceId: TRACE,
                  spanId: SPAN,
                  name: "GET /x",
                  kind: 2,
                  startTimeUnixNano: "1761700000000000000",
                  endTimeUnixNano: "1761700000012345678",
                  attributes: [
                    { key: "s", value: { stringValue: "v" } },
                    { key: "i", value: { intValue: "9007199254740993" } },
                    { key: "i2", value: { intValue: 42 } },
                    { key: "d", value: { doubleValue: 1.5 } },
                    { key: "b", value: { boolValue: true } },
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
                  status: { code: "STATUS_CODE_ERROR", message: "boom" },
                },
              ],
            },
          ],
        },
      ],
    };
    const r = parseOtlp(payload);
    expect(r.spans).toHaveLength(1);
    const s = r.spans[0];
    expect(s?.service).toBe("shop");
    expect(s?.kind).toBe("server");
    expect(s?.status).toBe("error");
    expect(s?.statusMessage).toBe("boom");
    expect(s?.startUs).toBe(1761700000000000);
    expect(s?.durationUs).toBe(12345);
    expect(s?.attributes).toEqual({
      s: "v",
      i: 9007199254740992, // int64 beyond 2^53 is rounded by Number()
      i2: 42,
      d: 1.5,
      b: true,
      bytes: "AAEC",
      arr: ["a", 2, [false]],
      kv: { k: 0.25, n: {} },
      empty: null,
    });
    expect(s?.scope).toBe("test");
  });

  it("accepts string kinds, legacy keys, base64 ids, JSONL and skips bad spans", () => {
    const b64Trace = Buffer.from(TRACE, "hex").toString("base64");
    const line1 = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [] },
          instrumentationLibrarySpans: [
            {
              instrumentationLibrary: { name: "old" },
              spans: [
                {
                  traceId: b64Trace,
                  spanId: SPAN,
                  name: "c",
                  kind: "SPAN_KIND_CLIENT",
                  startTimeUnixNano: 2000,
                  endTimeUnixNano: 1000,
                },
                { traceId: TRACE, name: "no span id", startTimeUnixNano: "1" },
              ],
            },
          ],
        },
      ],
    });
    const r = parseOtlp(`${line1}\nnot json\n\n`);
    expect(r.spans).toHaveLength(1);
    expect(r.spans[0]?.traceId).toBe(TRACE);
    expect(r.spans[0]?.kind).toBe("client");
    expect(r.spans[0]?.service).toBe("unknown_service");
    expect(r.spans[0]?.durationUs).toBe(0); // end < start clamped
    expect(r.warnings.some((w) => w.includes("line 2"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("skipped"))).toBe(true);
  });

  it("bounds memory with maxSpans", () => {
    const spans = Array.from({ length: 5 }, (_, i) => ({
      traceId: TRACE,
      spanId: `000000000000000${i}`,
      name: "x",
      startTimeUnixNano: "1000",
      endTimeUnixNano: "2000",
    }));
    const r = parseOtlp({ resourceSpans: [{ scopeSpans: [{ spans }] }] }, { maxSpans: 3 });
    expect(r.spans).toHaveLength(3);
    expect(r.droppedSpans).toBe(2);
  });

  it("parses metrics (sum, gauge, histogram, summary)", () => {
    const r = parseOtlp({
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "shop" } }] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "c",
                  sum: {
                    isMonotonic: true,
                    aggregationTemporality: 2,
                    dataPoints: [{ asInt: "7", timeUnixNano: "5000" }],
                  },
                },
                { name: "g", unit: "1", gauge: { dataPoints: [{ asDouble: 0.5 }] } },
                {
                  name: "http.server.request.duration",
                  unit: "s",
                  histogram: {
                    aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE",
                    dataPoints: [
                      { count: "10", sum: 1, bucketCounts: ["2", "8", "0"], explicitBounds: [0.05, 0.1] },
                    ],
                  },
                },
                {
                  name: "s",
                  summary: { dataPoints: [{ count: 3, quantileValues: [{ quantile: 0.5, value: 2 }] }] },
                },
                { name: "unknown" },
              ],
            },
          ],
        },
      ],
    });
    expect(r.metrics.map((m) => m.type)).toEqual(["sum", "gauge", "histogram", "summary"]);
    expect(r.metrics[0]?.points[0]?.value).toBe(7);
    expect(r.metrics[0]?.temporality).toBe("cumulative");
    expect(r.metrics[0]?.monotonic).toBe(true);
    expect(r.metrics[2]?.points[0]?.bucketCounts).toEqual([2, 8, 0]);
    expect(r.metrics[3]?.points[0]?.quantiles).toEqual([{ quantile: 0.5, value: 2 }]);
    expect(r.warnings.some((w) => w.includes("unknown"))).toBe(true);
  });

  it("helpers", () => {
    expect(nanosToMicros("1761700000123456789")).toBe(1761700000123456);
    expect(nanosToMicros(1500)).toBe(1);
    expect(nanosToMicros(10n ** 12n)).toBe(10 ** 9);
    expect(nanosToMicros("abc")).toBeUndefined();
    expect(normalizeId(TRACE.toUpperCase(), 16)).toBe(TRACE);
    expect(anyValue({ arrayValue: {} })).toEqual([]);
    // 10 obs: bounds 10/20; 5 in (0,10], 5 in (10,20] → p50 = 10, p95 = 19
    expect(histogramQuantile(0.5, [10, 20], [5, 5, 0])).toBeCloseTo(10, 9);
    expect(histogramQuantile(0.95, [10, 20], [5, 5, 0])).toBeCloseTo(19, 9);
    expect(histogramQuantile(0.99, [10, 20], [0, 0, 4])).toBe(20); // +Inf bucket → last bound
    expect(histogramQuantile(0.5, [10], [0, 0])).toBeNaN();
  });
});

describe("Prometheus text parsing", () => {
  const text = [
    "# HELP http_requests_total Total requests.\\nSecond line with \\\\ backslash",
    "# TYPE http_requests_total counter",
    'http_requests_total{method="GET",route="/products/:id",status="200"} 1027 1395066363000',
    'http_requests_total{method="GET",route="/products/:id",status="500"} 3',
    'weird{path="C:\\\\dir",msg="say \\"hi\\"\\nbye", empty=""} +Inf',
    "# TYPE http_request_duration_seconds histogram",
    'http_request_duration_seconds_bucket{route="/x",le="0.05"} 24054',
    'http_request_duration_seconds_bucket{route="/x",le="0.1"} 33444',
    'http_request_duration_seconds_bucket{route="/x",le="0.2"} 100392',
    'http_request_duration_seconds_bucket{route="/x",le="+Inf"} 144320',
    'http_request_duration_seconds_sum{route="/x"} 53423',
    'http_request_duration_seconds_count{route="/x"} 144320',
    "no_labels 3.5e2",
    "nan_metric NaN",
    'broken{a="unterminated} 1',
    "bad_value abc",
    'exemplar_total{a="b"} 5 # {trace_id="abc"} 1.0',
  ].join("\n");

  it("parses families, labels with escapes, HELP, timestamps and special values", () => {
    const r = parsePrometheus(text);
    const names = r.families.map((f) => f.name);
    expect(names).toEqual([
      "http_requests_total",
      "weird",
      "http_request_duration_seconds",
      "no_labels",
      "nan_metric",
      "exemplar_total",
    ]);
    const req = r.families[0];
    expect(req?.type).toBe("counter");
    expect(req?.help).toBe("Total requests.\nSecond line with \\ backslash");
    expect(req?.samples[0]).toEqual({
      name: "http_requests_total",
      labels: { method: "GET", route: "/products/:id", status: "200" },
      value: 1027,
      timestampMs: 1395066363000,
    });
    const weird = r.families[1]?.samples[0];
    expect(weird?.labels).toEqual({ path: "C:\\dir", msg: 'say "hi"\nbye', empty: "" });
    expect(weird?.value).toBe(Number.POSITIVE_INFINITY);
    expect(r.families[3]?.samples[0]?.value).toBe(350);
    expect(r.families[4]?.samples[0]?.value).toBeNaN();
    expect(r.families[5]?.samples[0]?.value).toBe(5);
    expect(r.warnings).toHaveLength(2);
  });

  it("groups histograms and computes quantiles like histogram_quantile", () => {
    const fam = parsePrometheus(text).families.find((f) => f.type === "histogram");
    expect(fam).toBeDefined();
    const series = histogramSeries(fam as NonNullable<typeof fam>);
    expect(series).toHaveLength(1);
    const s = series[0] as (typeof series)[number];
    expect(s.labels).toEqual({ route: "/x" });
    expect(s.buckets.map((b) => b.le)).toEqual([0.05, 0.1, 0.2, Number.POSITIVE_INFINITY]);
    expect(s.count).toBe(144320);
    expect(s.sum).toBe(53423);
    // rank 0.5*144320 = 72160 → in (0.1, 0.2]: 0.1 + 0.1 * (72160-33444)/(100392-33444)
    expect(promHistogramQuantile(0.5, s)).toBeCloseTo(0.1 + (0.1 * (72160 - 33444)) / (100392 - 33444), 9);
    // p95 falls into +Inf bucket → highest finite bound
    expect(promHistogramQuantile(0.95, s)).toBe(0.2);
  });
});
