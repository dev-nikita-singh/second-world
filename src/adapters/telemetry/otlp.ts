/**
 * OTLP/JSON ingestion (no OpenTelemetry SDK) — docs/03-engines/system-model.md §1 (runtime traces),
 * OTLP spec "JSON Protobuf Encoding": `resourceSpans[].scopeSpans[].spans[]`, `resourceMetrics[].scopeMetrics[].metrics[]`.
 *
 * Accepts: one payload object, an array of payloads, or JSONL text (one payload per line). Tolerates
 * the legacy `instrumentationLibrarySpans` / `instrumentationLibraryMetrics` keys, numeric or string
 * enum values (`kind: 2` or `"SPAN_KIND_SERVER"`), int64 as JSON strings, and nanosecond timestamps as
 * strings (converted to microseconds since the epoch; < 2^53 until year 2255).
 * Protobuf encoding is decoded by ./otlp-proto.ts into this same JSON shape, then parsed here.
 */

export type AttrValue = string | number | boolean | null | AttrValue[] | { [k: string]: AttrValue };
export type Attributes = Record<string, AttrValue>;

export type SpanKind = "unspecified" | "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatus = "unset" | "ok" | "error";

export interface NormalizedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  /** Microseconds since the Unix epoch. */
  startUs: number;
  endUs: number;
  durationUs: number;
  status: SpanStatus;
  statusMessage?: string;
  /** resource `service.name` (or "unknown_service"). */
  service: string;
  attributes: Attributes;
  resource: Attributes;
  scope?: string;
}

export type MetricType = "gauge" | "sum" | "histogram" | "exponentialHistogram" | "summary";

export interface MetricPoint {
  attributes: Attributes;
  timeUs?: number;
  startTimeUs?: number;
  /** gauge / sum value. */
  value?: number;
  /** histogram */
  count?: number;
  sum?: number;
  bucketCounts?: number[];
  explicitBounds?: number[];
  /** summary */
  quantiles?: { quantile: number; value: number }[];
}

export interface NormalizedMetric {
  name: string;
  unit: string;
  type: MetricType;
  monotonic?: boolean;
  temporality?: "delta" | "cumulative" | "unspecified";
  service: string;
  resource: Attributes;
  points: MetricPoint[];
}

export interface OtlpParseResult {
  spans: NormalizedSpan[];
  metrics: NormalizedMetric[];
  /** Non-fatal problems (bad lines, spans without ids, …). */
  warnings: string[];
  /** Spans dropped because `maxSpans` was reached. */
  droppedSpans: number;
}

export interface OtlpParseOptions {
  maxSpans?: number;
  maxWarnings?: number;
}

const KIND_BY_NUM: SpanKind[] = ["unspecified", "internal", "server", "client", "producer", "consumer"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** OTLP AnyValue → plain JS (int64 strings → number). Iterative for nested arrays/kvlists. */
export function anyValue(v: unknown): AttrValue {
  // Iterative conversion with an explicit work stack (no recursion on user-sized input).
  const root: { out: AttrValue } = { out: null };
  const stack: { src: unknown; set: (x: AttrValue) => void }[] = [
    {
      src: v,
      set: (x) => {
        root.out = x;
      },
    },
  ];
  while (stack.length > 0) {
    const { src, set } = stack.pop() as { src: unknown; set: (x: AttrValue) => void };
    if (!isObj(src)) {
      set(src === undefined ? null : (src as AttrValue));
      continue;
    }
    if ("stringValue" in src) set(String(src.stringValue));
    else if ("boolValue" in src) set(src.boolValue === true || src.boolValue === "true");
    else if ("intValue" in src) set(Number(src.intValue));
    else if ("doubleValue" in src) set(Number(src.doubleValue));
    else if ("bytesValue" in src) set(String(src.bytesValue));
    else if ("arrayValue" in src) {
      const values = arr(isObj(src.arrayValue) ? src.arrayValue.values : undefined);
      const out: AttrValue[] = new Array(values.length).fill(null);
      set(out);
      values.forEach((x, i) => {
        stack.push({
          src: x,
          set: (y) => {
            out[i] = y;
          },
        });
      });
    } else if ("kvlistValue" in src) {
      const values = arr(isObj(src.kvlistValue) ? src.kvlistValue.values : undefined);
      const out: { [k: string]: AttrValue } = {};
      set(out);
      for (const kv of values) {
        if (!isObj(kv) || typeof kv.key !== "string") continue;
        const key = kv.key;
        stack.push({
          src: kv.value,
          set: (y) => {
            out[key] = y;
          },
        });
      }
    } else set(null);
  }
  return root.out;
}

export function attributesOf(list: unknown): Attributes {
  const out: Attributes = {};
  for (const kv of arr(list)) {
    if (!isObj(kv) || typeof kv.key !== "string") continue;
    out[kv.key] = anyValue(kv.value);
  }
  return out;
}

/** Nanoseconds (string | number | bigint) → microseconds since epoch. */
export function nanosToMicros(v: unknown): number | undefined {
  if (typeof v === "bigint") return Number(v / 1000n);
  if (typeof v === "number") return Number.isFinite(v) ? Math.floor(v / 1000) : undefined;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    try {
      return Number(BigInt(v.trim()) / 1000n);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function spanKind(v: unknown): SpanKind {
  if (typeof v === "number") return KIND_BY_NUM[v] ?? "unspecified";
  if (typeof v === "string") {
    const s = v.toLowerCase().replace(/^span_kind_/, "");
    if ((KIND_BY_NUM as string[]).includes(s)) return s as SpanKind;
    const n = Number(v);
    if (Number.isInteger(n)) return KIND_BY_NUM[n] ?? "unspecified";
  }
  return "unspecified";
}

function spanStatus(v: unknown): { status: SpanStatus; message?: string } {
  if (!isObj(v)) return { status: "unset" };
  const c = v.code;
  let status: SpanStatus = "unset";
  if (c === 1 || c === "1" || c === "STATUS_CODE_OK") status = "ok";
  else if (c === 2 || c === "2" || c === "STATUS_CODE_ERROR") status = "error";
  return typeof v.message === "string" && v.message !== "" ? { status, message: v.message } : { status };
}

/** OTLP/JSON ids are hex; base64 ids (from protobuf→JSON converters) are converted to hex. */
export function normalizeId(v: unknown, bytes: number): string | undefined {
  if (typeof v !== "string" || v === "") return undefined;
  if (/^[0-9a-fA-F]+$/.test(v) && v.length === bytes * 2) return v.toLowerCase();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(v) && Math.ceil((bytes * 4) / 3) <= v.length && v.length <= bytes * 2) {
    const b = Buffer.from(v, "base64");
    if (b.length === bytes) return b.toString("hex");
  }
  return v.toLowerCase();
}

const serviceOf = (res: Attributes): string => {
  const s = res["service.name"];
  return typeof s === "string" && s !== "" ? s : "unknown_service";
};

function scopeList(rs: Obj, key: "Spans" | "Metrics"): unknown[] {
  return [...arr(rs[`scope${key}`]), ...arr(rs[`instrumentationLibrary${key}`])];
}

/** Collect payload objects from text (JSON or JSONL), an object, or an array. */
export function payloadsOf(input: unknown, warnings: string[] = []): Obj[] {
  if (typeof input === "string") {
    const t = input.trim();
    if (t === "") return [];
    try {
      return payloadsOf(JSON.parse(t), warnings);
    } catch {
      const out: Obj[] = [];
      const lines = t.split(/\r?\n/);
      lines.forEach((line, i) => {
        const l = line.trim();
        if (l === "") return;
        try {
          const v = JSON.parse(l) as unknown;
          if (isObj(v)) out.push(v);
          else if (Array.isArray(v)) out.push(...v.filter(isObj));
        } catch {
          if (warnings.length < 50) warnings.push(`line ${i + 1}: not valid JSON`);
        }
      });
      return out;
    }
  }
  if (Array.isArray(input)) return input.filter(isObj);
  return isObj(input) ? [input] : [];
}

/** Parse OTLP/JSON traces and/or metrics. Never throws on malformed content (warnings instead). */
export function parseOtlp(input: unknown, opts: OtlpParseOptions = {}): OtlpParseResult {
  const maxSpans = opts.maxSpans ?? 1_000_000;
  const warnings: string[] = [];
  const warn = (w: string) => {
    if (warnings.length < (opts.maxWarnings ?? 50)) warnings.push(w);
  };
  const spans: NormalizedSpan[] = [];
  const metrics: NormalizedMetric[] = [];
  let dropped = 0;
  for (const p of payloadsOf(input, warnings)) {
    for (const rs of arr(p.resourceSpans)) {
      if (!isObj(rs)) continue;
      const resource = attributesOf(isObj(rs.resource) ? rs.resource.attributes : undefined);
      const service = serviceOf(resource);
      for (const ss of scopeList(rs, "Spans")) {
        if (!isObj(ss)) continue;
        const scopeObj = isObj(ss.scope)
          ? ss.scope
          : isObj(ss.instrumentationLibrary)
            ? ss.instrumentationLibrary
            : {};
        const scope = typeof scopeObj.name === "string" ? scopeObj.name : undefined;
        for (const s of arr(ss.spans)) {
          if (!isObj(s)) continue;
          const traceId = normalizeId(s.traceId, 16);
          const spanId = normalizeId(s.spanId, 8);
          const startUs = nanosToMicros(s.startTimeUnixNano);
          const endUs0 = nanosToMicros(s.endTimeUnixNano);
          if (!traceId || !spanId || startUs === undefined) {
            warn(`span without traceId/spanId/startTimeUnixNano skipped (${String(s.name ?? "?")})`);
            continue;
          }
          if (spans.length >= maxSpans) {
            dropped++;
            continue;
          }
          const endUs = endUs0 !== undefined && endUs0 >= startUs ? endUs0 : startUs;
          const parent = normalizeId(s.parentSpanId, 8);
          const st = spanStatus(s.status);
          const span: NormalizedSpan = {
            traceId,
            spanId,
            name: typeof s.name === "string" ? s.name : "",
            kind: spanKind(s.kind),
            startUs,
            endUs,
            durationUs: endUs - startUs,
            status: st.status,
            service,
            attributes: attributesOf(s.attributes),
            resource,
          };
          if (parent) span.parentSpanId = parent;
          if (st.message) span.statusMessage = st.message;
          if (scope) span.scope = scope;
          spans.push(span);
        }
      }
    }
    for (const rm of arr(p.resourceMetrics)) {
      if (!isObj(rm)) continue;
      const resource = attributesOf(isObj(rm.resource) ? rm.resource.attributes : undefined);
      const service = serviceOf(resource);
      for (const sm of scopeList(rm, "Metrics")) {
        if (!isObj(sm)) continue;
        for (const m of arr(sm.metrics)) {
          if (!isObj(m) || typeof m.name !== "string") continue;
          const nm = parseMetric(m, service, resource);
          if (nm) metrics.push(nm);
          else warn(`metric ${m.name}: unsupported data type`);
        }
      }
    }
  }
  return { spans, metrics, warnings, droppedSpans: dropped };
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function temporality(v: unknown): "delta" | "cumulative" | "unspecified" {
  if (v === 1 || v === "1" || v === "AGGREGATION_TEMPORALITY_DELTA") return "delta";
  if (v === 2 || v === "2" || v === "AGGREGATION_TEMPORALITY_CUMULATIVE") return "cumulative";
  return "unspecified";
}

function basePoint(dp: Obj): MetricPoint {
  const p: MetricPoint = { attributes: attributesOf(dp.attributes) };
  const t = nanosToMicros(dp.timeUnixNano);
  const st = nanosToMicros(dp.startTimeUnixNano);
  if (t !== undefined) p.timeUs = t;
  if (st !== undefined) p.startTimeUs = st;
  return p;
}

function parseMetric(m: Obj, service: string, resource: Attributes): NormalizedMetric | undefined {
  const base = { name: m.name as string, unit: typeof m.unit === "string" ? m.unit : "", service, resource };
  const numberPoints = (data: Obj): MetricPoint[] =>
    arr(data.dataPoints)
      .filter(isObj)
      .map((dp) => {
        const p = basePoint(dp);
        const v = num(dp.asDouble) ?? num(dp.asInt);
        if (v !== undefined) p.value = v;
        return p;
      });
  if (isObj(m.gauge)) return { ...base, type: "gauge", points: numberPoints(m.gauge) };
  if (isObj(m.sum))
    return {
      ...base,
      type: "sum",
      monotonic: m.sum.isMonotonic === true,
      temporality: temporality(m.sum.aggregationTemporality),
      points: numberPoints(m.sum),
    };
  if (isObj(m.histogram)) {
    const points = arr(m.histogram.dataPoints)
      .filter(isObj)
      .map((dp) => {
        const p = basePoint(dp);
        const c = num(dp.count);
        const s = num(dp.sum);
        if (c !== undefined) p.count = c;
        if (s !== undefined) p.sum = s;
        p.bucketCounts = arr(dp.bucketCounts).map((x) => num(x) ?? 0);
        p.explicitBounds = arr(dp.explicitBounds).map((x) => num(x) ?? 0);
        return p;
      });
    return {
      ...base,
      type: "histogram",
      temporality: temporality(m.histogram.aggregationTemporality),
      points,
    };
  }
  if (isObj(m.summary)) {
    const points = arr(m.summary.dataPoints)
      .filter(isObj)
      .map((dp) => {
        const p = basePoint(dp);
        const c = num(dp.count);
        const s = num(dp.sum);
        if (c !== undefined) p.count = c;
        if (s !== undefined) p.sum = s;
        p.quantiles = arr(dp.quantileValues)
          .filter(isObj)
          .map((q) => ({ quantile: num(q.quantile) ?? 0, value: num(q.value) ?? 0 }));
        return p;
      });
    return { ...base, type: "summary", points };
  }
  if (isObj(m.exponentialHistogram)) {
    const points = arr(m.exponentialHistogram.dataPoints)
      .filter(isObj)
      .map((dp) => {
        const p = basePoint(dp);
        const c = num(dp.count);
        const s = num(dp.sum);
        if (c !== undefined) p.count = c;
        if (s !== undefined) p.sum = s;
        return p;
      });
    return { ...base, type: "exponentialHistogram", points };
  }
  return undefined;
}

/**
 * Quantile from explicit-bucket histogram counts (linear interpolation inside the bucket,
 * Prometheus `histogram_quantile` semantics; the +Inf bucket returns its lower bound).
 * `bounds[i]` is the upper bound of bucket i; there are bounds.length + 1 buckets.
 */
export function histogramQuantile(q: number, bounds: readonly number[], counts: readonly number[]): number {
  let total = 0;
  for (const c of counts) total += c;
  if (total <= 0) return Number.NaN;
  const rank = q * total;
  let cum = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i] ?? 0;
    if (cum + c >= rank && c > 0) {
      const lower = i === 0 ? Math.min(0, bounds[0] ?? 0) : (bounds[i - 1] ?? 0);
      const upper = bounds[i];
      if (upper === undefined) return bounds[bounds.length - 1] ?? 0;
      return lower + (upper - lower) * ((rank - cum) / c);
    }
    cum += c;
  }
  return bounds[bounds.length - 1] ?? Number.NaN;
}
