/**
 * OTLP protobuf ingestion (no protobuf library) — docs/03-engines/system-model.md §1 (runtime traces).
 * A small, bounded protobuf wire-format decoder (varint, I64, LEN, I32; unknown fields skipped; groups
 * rejected) for the subset of opentelemetry-proto that the OTLP/JSON path uses:
 *
 *   collector/trace/v1   ExportTraceServiceRequest  { ResourceSpans resource_spans = 1 }
 *   trace/v1             ResourceSpans { Resource resource = 1; ScopeSpans scope_spans = 2;
 *                                        (deprecated) InstrumentationLibrarySpans = 1000 }
 *                        ScopeSpans    { InstrumentationScope scope = 1; Span spans = 2 }
 *                        Span          { bytes trace_id = 1; bytes span_id = 2; bytes parent_span_id = 4;
 *                                        string name = 5; SpanKind kind = 6; fixed64 start_time_unix_nano = 7;
 *                                        fixed64 end_time_unix_nano = 8; KeyValue attributes = 9; Status status = 15 }
 *                        Status        { string message = 2; StatusCode code = 3 }
 *   collector/metrics/v1 ExportMetricsServiceRequest { ResourceMetrics resource_metrics = 1 }
 *   metrics/v1           ResourceMetrics { Resource resource = 1; ScopeMetrics scope_metrics = 2; (deprecated) = 1000 }
 *                        ScopeMetrics  { InstrumentationScope scope = 1; Metric metrics = 2 }
 *                        Metric        { string name = 1; string unit = 3; Gauge gauge = 5; Sum sum = 7;
 *                                        Histogram histogram = 9; ExponentialHistogram exponential_histogram = 10;
 *                                        Summary summary = 11 }
 *                        Gauge { NumberDataPoint data_points = 1 }
 *                        Sum { NumberDataPoint data_points = 1; AggregationTemporality aggregation_temporality = 2;
 *                              bool is_monotonic = 3 }
 *                        Histogram / ExponentialHistogram { data_points = 1; aggregation_temporality = 2 }
 *                        Summary { SummaryDataPoint data_points = 1 }
 *                        NumberDataPoint { fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3;
 *                                          double as_double = 4; sfixed64 as_int = 6; KeyValue attributes = 7 }
 *                        HistogramDataPoint { 2, 3 times; fixed64 count = 4; double sum = 5;
 *                                             repeated fixed64 bucket_counts = 6; repeated double explicit_bounds = 7;
 *                                             KeyValue attributes = 9 }
 *                        ExponentialHistogramDataPoint { KeyValue attributes = 1; 2, 3 times; fixed64 count = 4;
 *                                                        double sum = 5 }
 *                        SummaryDataPoint { 2, 3 times; fixed64 count = 4; double sum = 5;
 *                                           ValueAtQuantile quantile_values = 6 { double quantile = 1; double value = 2 };
 *                                           KeyValue attributes = 7 }
 *   common/v1            KeyValue { string key = 1; AnyValue value = 2 }
 *                        AnyValue { string_value = 1; bool_value = 2; int64 int_value = 3; double double_value = 4;
 *                                   ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes bytes_value = 7 }
 *                        ArrayValue { AnyValue values = 1 }  KeyValueList { KeyValue values = 1 }
 *                        InstrumentationScope { string name = 1; string version = 2 }
 *   resource/v1          Resource { KeyValue attributes = 1 }
 *
 * The decoder emits the OTLP/JSON shape (hex ids, int64/fixed64 as decimal strings, numeric enums,
 * base64 bytes), which `parseOtlp` then normalises, so everything downstream is shared with JSON.
 * Bounds: input size (`maxBytes`), nesting depth (`maxDepth`, recursion only up to that depth),
 * spans kept (`maxSpans`, the rest are skipped and counted). Malformed input throws `OtlpProtobufError`.
 */
import { type OtlpParseOptions, type OtlpParseResult, parseOtlp } from "./otlp.js";

export type OtlpSignal = "traces" | "metrics";

export class OtlpProtobufError extends Error {
  readonly code = "SW_OTLP_PROTOBUF";
  constructor(message: string) {
    super(`OTLP protobuf: ${message}`);
    this.name = "OtlpProtobufError";
  }
}

export interface OtlpProtobufOptions {
  /** Which request message the bytes hold; "auto" inspects the first span/metric (default). */
  signal?: OtlpSignal | "auto";
  /** Maximum input size (default 256 MiB). */
  maxBytes?: number;
  /** Maximum message nesting depth (default 64; the OTLP span path itself is 7 deep). */
  maxDepth?: number;
  /** Spans beyond this are skipped without decoding and counted in `droppedSpans`. */
  maxSpans?: number;
}

export interface OtlpProtobufDecoded {
  signal: OtlpSignal;
  /** OTLP/JSON-shaped payload (`{ resourceSpans }` or `{ resourceMetrics }`). */
  payload: Record<string, unknown>;
  droppedSpans: number;
}

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

/** Bounded cursor over a byte range. All reads check bounds and throw `OtlpProtobufError`. */
class Reader {
  private readonly view: DataView;
  constructor(
    readonly buf: Uint8Array,
    public pos: number,
    readonly end: number,
    readonly depth: number,
    view?: DataView,
  ) {
    this.view = view ?? new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  more(): boolean {
    return this.pos < this.end;
  }

  private need(n: number): void {
    if (n > this.end - this.pos) throw new OtlpProtobufError(`truncated message at byte ${this.pos}`);
  }

  /** Unsigned varint as a number (exact up to 2^53; used for tags, lengths, enums, bools). */
  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new OtlpProtobufError(`truncated varint at byte ${this.pos}`);
      const b = this.buf[this.pos++] as number;
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
    throw new OtlpProtobufError(`varint longer than 10 bytes at byte ${this.pos}`);
  }

  /** Varint as a 64-bit two's-complement signed integer (int64). */
  varintInt64(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new OtlpProtobufError(`truncated varint at byte ${this.pos}`);
      const b = this.buf[this.pos++] as number;
      result |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return BigInt.asIntN(64, result);
      shift += 7n;
    }
    throw new OtlpProtobufError(`varint longer than 10 bytes at byte ${this.pos}`);
  }

  fixed64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  sfixed64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }

  double(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** Length-delimited payload bounds: [start, end). */
  lenRange(): [number, number] {
    const len = this.varint();
    this.need(len);
    const start = this.pos;
    this.pos += len;
    return [start, start + len];
  }

  bytes(): Uint8Array {
    const [s, e] = this.lenRange();
    return this.buf.subarray(s, e);
  }

  string(): string {
    return Buffer.from(this.bytes()).toString("utf8");
  }

  /** Nested message reader (depth-checked). */
  sub(maxDepth: number): Reader {
    if (this.depth + 1 > maxDepth) throw new OtlpProtobufError(`nesting deeper than ${maxDepth} levels`);
    const [s, e] = this.lenRange();
    return new Reader(this.buf, s, e, this.depth + 1, this.view);
  }

  /** Reader over [s, e) of the same buffer at the same depth (packed repeated fields). */
  slice(s: number, e: number): Reader {
    return new Reader(this.buf, s, e, this.depth, this.view);
  }

  /** Next field tag. */
  tag(): { field: number; wire: number } {
    const t = this.varint();
    const field = Math.floor(t / 8);
    const wire = t % 8;
    if (field === 0) throw new OtlpProtobufError(`invalid field number 0 at byte ${this.pos}`);
    if (wire === 3 || wire === 4) throw new OtlpProtobufError("groups (wire types 3/4) are not supported");
    if (wire !== WIRE_VARINT && wire !== WIRE_I64 && wire !== WIRE_LEN && wire !== WIRE_I32)
      throw new OtlpProtobufError(`invalid wire type ${wire} at byte ${this.pos}`);
    return { field, wire };
  }

  skip(wire: number): void {
    if (wire === WIRE_VARINT) this.varint();
    else if (wire === WIRE_I64) {
      this.need(8);
      this.pos += 8;
    } else if (wire === WIRE_LEN) this.lenRange();
    else {
      this.need(4);
      this.pos += 4;
    }
  }
}

type Obj = Record<string, unknown>;

interface Ctx {
  maxDepth: number;
  maxSpans: number;
  spans: number;
  dropped: number;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Repeated fixed64 / double: packed (LEN) or unpacked (I64) encodings are both accepted. */
function repeated64(
  r: Reader,
  wire: number,
  read: (x: Reader) => string | number,
  out: (string | number)[],
): void {
  if (wire === WIRE_I64) {
    out.push(read(r));
    return;
  }
  if (wire !== WIRE_LEN) {
    r.skip(wire);
    return;
  }
  const [s, e] = r.lenRange();
  if ((e - s) % 8 !== 0) throw new OtlpProtobufError("packed 64-bit field length is not a multiple of 8");
  const p = r.slice(s, e);
  while (p.more()) out.push(read(p));
}

// ---- common/v1, resource/v1 ----------------------------------------------------------------------

function anyValue(r: Reader, c: Ctx): Obj {
  const out: Obj = {};
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.stringValue = r.string();
    else if (field === 2 && wire === WIRE_VARINT) out.boolValue = r.varint() !== 0;
    else if (field === 3 && wire === WIRE_VARINT) out.intValue = r.varintInt64().toString();
    else if (field === 4 && wire === WIRE_I64) out.doubleValue = r.double();
    else if (field === 5 && wire === WIRE_LEN)
      out.arrayValue = { values: list(r.sub(c.maxDepth), c, anyValue) };
    else if (field === 6 && wire === WIRE_LEN)
      out.kvlistValue = { values: list(r.sub(c.maxDepth), c, keyValue) };
    else if (field === 7 && wire === WIRE_LEN) out.bytesValue = Buffer.from(r.bytes()).toString("base64");
    else r.skip(wire);
  }
  return out;
}

/** ArrayValue / KeyValueList: `repeated X values = 1`. */
function list(r: Reader, c: Ctx, item: (r: Reader, c: Ctx) => Obj): Obj[] {
  const out: Obj[] = [];
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.push(item(r.sub(c.maxDepth), c));
    else r.skip(wire);
  }
  return out;
}

function keyValue(r: Reader, c: Ctx): Obj {
  const out: Obj = { key: "", value: {} };
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.key = r.string();
    else if (field === 2 && wire === WIRE_LEN) out.value = anyValue(r.sub(c.maxDepth), c);
    else r.skip(wire);
  }
  return out;
}

/** Resource (attributes = 1) or a data point's attributes field: both yield KeyValue[]. */
function resource(r: Reader, c: Ctx): Obj {
  const attributes: Obj[] = [];
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) attributes.push(keyValue(r.sub(c.maxDepth), c));
    else r.skip(wire);
  }
  return { attributes };
}

/** InstrumentationScope / deprecated InstrumentationLibrary: name = 1, version = 2. */
function scope(r: Reader): Obj {
  const out: Obj = {};
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.name = r.string();
    else if (field === 2 && wire === WIRE_LEN) out.version = r.string();
    else r.skip(wire);
  }
  return out;
}

// ---- trace/v1 ------------------------------------------------------------------------------------

function status(r: Reader): Obj {
  const out: Obj = {};
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 2 && wire === WIRE_LEN) out.message = r.string();
    else if (field === 3 && wire === WIRE_VARINT) out.code = r.varint();
    else r.skip(wire);
  }
  return out;
}

function span(r: Reader, c: Ctx): Obj {
  const out: Obj = {};
  const attributes: Obj[] = [];
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.traceId = hex(r.bytes());
    else if (field === 2 && wire === WIRE_LEN) out.spanId = hex(r.bytes());
    else if (field === 4 && wire === WIRE_LEN) {
      const p = r.bytes();
      if (p.length > 0) out.parentSpanId = hex(p);
    } else if (field === 5 && wire === WIRE_LEN) out.name = r.string();
    else if (field === 6 && wire === WIRE_VARINT) out.kind = r.varint();
    else if (field === 7 && wire === WIRE_I64) out.startTimeUnixNano = r.fixed64().toString();
    else if (field === 8 && wire === WIRE_I64) out.endTimeUnixNano = r.fixed64().toString();
    else if (field === 9 && wire === WIRE_LEN) attributes.push(keyValue(r.sub(c.maxDepth), c));
    else if (field === 15 && wire === WIRE_LEN) out.status = status(r.sub(c.maxDepth));
    else r.skip(wire);
  }
  out.attributes = attributes;
  return out;
}

function scopeSpans(r: Reader, c: Ctx): Obj {
  const out: Obj = {};
  const spans: Obj[] = [];
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.scope = scope(r.sub(c.maxDepth));
    else if (field === 2 && wire === WIRE_LEN) {
      if (c.spans >= c.maxSpans) {
        r.skip(wire);
        c.dropped++;
        continue;
      }
      c.spans++;
      spans.push(span(r.sub(c.maxDepth), c));
    } else r.skip(wire);
  }
  out.spans = spans;
  return out;
}

function resourceSpans(r: Reader, c: Ctx): Obj {
  const out: Obj = {};
  const scopes: Obj[] = [];
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.resource = resource(r.sub(c.maxDepth), c);
    // 1000 = deprecated instrumentation_library_spans (same layout as ScopeSpans).
    else if ((field === 2 || field === 1000) && wire === WIRE_LEN)
      scopes.push(scopeSpans(r.sub(c.maxDepth), c));
    else r.skip(wire);
  }
  out.scopeSpans = scopes;
  return out;
}

// ---- metrics/v1 ----------------------------------------------------------------------------------

type PointKind = "number" | "histogram" | "exponential" | "summary";
/** Field number of `attributes` per data point message. */
const ATTR_FIELD: Record<PointKind, number> = { number: 7, histogram: 9, exponential: 1, summary: 7 };

function quantile(r: Reader): Obj {
  const out: Obj = {};
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_I64) out.quantile = r.double();
    else if (field === 2 && wire === WIRE_I64) out.value = r.double();
    else r.skip(wire);
  }
  return out;
}

function dataPoint(r: Reader, c: Ctx, kind: PointKind): Obj {
  const out: Obj = {};
  const attributes: Obj[] = [];
  const bucketCounts: (string | number)[] = [];
  const explicitBounds: (string | number)[] = [];
  const quantileValues: Obj[] = [];
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === ATTR_FIELD[kind] && wire === WIRE_LEN) attributes.push(keyValue(r.sub(c.maxDepth), c));
    else if (field === 2 && wire === WIRE_I64) out.startTimeUnixNano = r.fixed64().toString();
    else if (field === 3 && wire === WIRE_I64) out.timeUnixNano = r.fixed64().toString();
    else if (kind === "number" && field === 4 && wire === WIRE_I64) out.asDouble = r.double();
    else if (kind === "number" && field === 6 && wire === WIRE_I64) out.asInt = r.sfixed64().toString();
    else if (kind !== "number" && field === 4 && wire === WIRE_I64) out.count = r.fixed64().toString();
    else if (kind !== "number" && field === 5 && wire === WIRE_I64) out.sum = r.double();
    else if (kind === "histogram" && field === 6)
      repeated64(r, wire, (x) => x.fixed64().toString(), bucketCounts);
    else if (kind === "histogram" && field === 7) repeated64(r, wire, (x) => x.double(), explicitBounds);
    else if (kind === "summary" && field === 6 && wire === WIRE_LEN)
      quantileValues.push(quantile(r.sub(c.maxDepth)));
    else r.skip(wire);
  }
  out.attributes = attributes;
  if (kind === "histogram") {
    out.bucketCounts = bucketCounts;
    out.explicitBounds = explicitBounds;
  }
  if (kind === "summary") out.quantileValues = quantileValues;
  return out;
}

/** Gauge / Sum / Histogram / ExponentialHistogram / Summary body. */
function metricData(r: Reader, c: Ctx, kind: PointKind, sum: boolean): Obj {
  const out: Obj = {};
  const dataPoints: Obj[] = [];
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) dataPoints.push(dataPoint(r.sub(c.maxDepth), c, kind));
    else if (field === 2 && wire === WIRE_VARINT && kind !== "summary")
      out.aggregationTemporality = r.varint();
    else if (field === 3 && wire === WIRE_VARINT && sum) out.isMonotonic = r.varint() !== 0;
    else r.skip(wire);
  }
  out.dataPoints = dataPoints;
  return out;
}

function metric(r: Reader, c: Ctx): Obj {
  const out: Obj = {};
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.name = r.string();
    else if (field === 3 && wire === WIRE_LEN) out.unit = r.string();
    else if (field === 5 && wire === WIRE_LEN) out.gauge = metricData(r.sub(c.maxDepth), c, "number", false);
    else if (field === 7 && wire === WIRE_LEN) out.sum = metricData(r.sub(c.maxDepth), c, "number", true);
    else if (field === 9 && wire === WIRE_LEN)
      out.histogram = metricData(r.sub(c.maxDepth), c, "histogram", false);
    else if (field === 10 && wire === WIRE_LEN)
      out.exponentialHistogram = metricData(r.sub(c.maxDepth), c, "exponential", false);
    else if (field === 11 && wire === WIRE_LEN)
      out.summary = metricData(r.sub(c.maxDepth), c, "summary", false);
    else r.skip(wire);
  }
  return out;
}

function scopeMetrics(r: Reader, c: Ctx): Obj {
  const out: Obj = {};
  const metrics: Obj[] = [];
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.scope = scope(r.sub(c.maxDepth));
    else if (field === 2 && wire === WIRE_LEN) metrics.push(metric(r.sub(c.maxDepth), c));
    else r.skip(wire);
  }
  out.metrics = metrics;
  return out;
}

function resourceMetrics(r: Reader, c: Ctx): Obj {
  const out: Obj = {};
  const scopes: Obj[] = [];
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.resource = resource(r.sub(c.maxDepth), c);
    // 1000 = deprecated instrumentation_library_metrics (same layout as ScopeMetrics).
    else if ((field === 2 || field === 1000) && wire === WIRE_LEN)
      scopes.push(scopeMetrics(r.sub(c.maxDepth), c));
    else r.skip(wire);
  }
  out.scopeMetrics = scopes;
  return out;
}

// ---- signal detection ----------------------------------------------------------------------------

/**
 * Both export requests are `repeated X = 1` of `{ resource = 1; repeated scope = 2 }` of
 * `{ scope = 1; repeated item = 2 }`, so the signal is told apart at the item: a Span has
 * fixed64 times (fields 7/8, wire I64) and a varint kind (6); a Metric has its data oneof as
 * messages (5/7/9/10/11, wire LEN). Undecidable (empty) requests count as traces.
 */
export function detectOtlpSignal(bytes: Uint8Array): OtlpSignal {
  const items = (r: Reader, fieldNos: number[], visit: (x: Reader) => OtlpSignal | undefined) => {
    while (r.more()) {
      const { field, wire } = r.tag();
      if (fieldNos.includes(field) && wire === WIRE_LEN) {
        const found = visit(r.sub(8));
        if (found) return found;
      } else r.skip(wire);
    }
    return undefined;
  };
  const classify = (r: Reader): OtlpSignal | undefined => {
    let metricHint = false;
    while (r.more()) {
      const { field, wire } = r.tag();
      if (((field === 7 || field === 8) && wire === WIRE_I64) || (field === 6 && wire === WIRE_VARINT))
        return "traces";
      if ([5, 7, 9, 10, 11].includes(field) && wire === WIRE_LEN) metricHint = true;
      r.skip(wire);
    }
    return metricHint ? "metrics" : undefined;
  };
  const top = new Reader(bytes, 0, bytes.length, 0);
  return items(top, [1], (res) => items(res, [2, 1000], (sc) => items(sc, [2], classify))) ?? "traces";
}

// ---- entry points --------------------------------------------------------------------------------

/** Decode an ExportTraceServiceRequest / ExportMetricsServiceRequest into the OTLP/JSON shape. */
export function decodeOtlpProtobuf(bytes: Uint8Array, opts: OtlpProtobufOptions = {}): OtlpProtobufDecoded {
  const maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
  if (bytes.length > maxBytes)
    throw new OtlpProtobufError(`input of ${bytes.length} bytes exceeds the ${maxBytes}-byte limit`);
  const signal = !opts.signal || opts.signal === "auto" ? detectOtlpSignal(bytes) : opts.signal;
  const c: Ctx = {
    maxDepth: Math.max(8, opts.maxDepth ?? 64),
    maxSpans: opts.maxSpans ?? 1_000_000,
    spans: 0,
    dropped: 0,
  };
  const r = new Reader(bytes, 0, bytes.length, 0);
  const resources: Obj[] = [];
  while (r.more()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN)
      resources.push(
        signal === "traces" ? resourceSpans(r.sub(c.maxDepth), c) : resourceMetrics(r.sub(c.maxDepth), c),
      );
    else r.skip(wire);
  }
  const payload = signal === "traces" ? { resourceSpans: resources } : { resourceMetrics: resources };
  return { signal, payload, droppedSpans: c.dropped };
}

/** Decode protobuf and normalise it exactly like OTLP/JSON. Throws `OtlpProtobufError` on malformed input. */
export function parseOtlpProtobuf(
  bytes: Uint8Array,
  opts: OtlpProtobufOptions & OtlpParseOptions = {},
): OtlpParseResult & { signal: OtlpSignal } {
  const d = decodeOtlpProtobuf(bytes, opts);
  const r = parseOtlp(d.payload, opts);
  return { ...r, droppedSpans: r.droppedSpans + d.droppedSpans, signal: d.signal };
}

/**
 * True when a telemetry file should be read as protobuf: a `.pb`/`.binpb`/`.protobuf`/`.bin` extension,
 * or (other than `.json`/`.jsonl`/`.ndjson`) content with a control byte in its first 64 KiB. OTLP/JSON
 * is text; any OTLP protobuf request with spans or metrics has a 0x12 tag (field 2, LEN) early on.
 */
export function isOtlpProtobufFile(file: string, content: Uint8Array): boolean {
  if (/\.(pb|binpb|protobuf|bin)$/i.test(file)) return true;
  if (/\.(json|jsonl|ndjson)$/i.test(file)) return false;
  const n = Math.min(content.length, 64 * 1024);
  for (let i = 0; i < n; i++) {
    const b = content[i] as number;
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) return true;
  }
  return false;
}

/** Encode a google.rpc.Status { int32 code = 1; string message = 2 } (OTLP/HTTP protobuf error body). */
export function encodeRpcStatus(code: number, message: string): Uint8Array {
  const msg = Buffer.from(message, "utf8");
  const out: number[] = [0x08];
  const varint = (n: number) => {
    let v = n;
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
  };
  varint(code);
  out.push(0x12);
  varint(msg.length);
  return Uint8Array.from([...out, ...msg]);
}
