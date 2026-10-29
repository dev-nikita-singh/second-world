/**
 * Test-only protobuf encoder for OTLP requests, written independently of the decoder in
 * src/adapters/telemetry/otlp-proto.ts. Field numbers follow opentelemetry-proto
 * (collector/{trace,metrics}/v1, trace/v1, metrics/v1, common/v1, resource/v1).
 * `encodeTraceRequest` / `encodeMetricsRequest` take an OTLP/JSON payload and build the bytes.
 */

type Field =
  | { f: number; t: "varint"; v: number | bigint }
  | { f: number; t: "fixed64"; v: bigint }
  | { f: number; t: "sfixed64"; v: bigint }
  | { f: number; t: "double"; v: number }
  | { f: number; t: "fixed32"; v: number }
  | { f: number; t: "bytes"; v: Uint8Array }
  | { f: number; t: "string"; v: string }
  | { f: number; t: "msg"; v: Field[] }
  | { f: number; t: "packedFixed64"; v: bigint[] }
  | { f: number; t: "packedDouble"; v: number[] };

export type { Field };

export function varintBytes(v: number | bigint): number[] {
  let x = BigInt.asUintN(64, BigInt(v));
  const out: number[] = [];
  do {
    let b = Number(x & 0x7fn);
    x >>= 7n;
    if (x > 0n) b |= 0x80;
    out.push(b);
  } while (x > 0n);
  return out;
}

const le64 = (write: (dv: DataView) => void): number[] => {
  const b = new Uint8Array(8);
  write(new DataView(b.buffer));
  return [...b];
};

const tag = (f: number, wire: number) => varintBytes(f * 8 + wire);

export function encode(fields: Field[]): Uint8Array {
  const out: number[] = [];
  for (const x of fields) {
    switch (x.t) {
      case "varint":
        out.push(...tag(x.f, 0), ...varintBytes(x.v));
        break;
      case "fixed64":
        out.push(...tag(x.f, 1), ...le64((d) => d.setBigUint64(0, x.v, true)));
        break;
      case "sfixed64":
        out.push(...tag(x.f, 1), ...le64((d) => d.setBigInt64(0, x.v, true)));
        break;
      case "double":
        out.push(...tag(x.f, 1), ...le64((d) => d.setFloat64(0, x.v, true)));
        break;
      case "fixed32": {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, x.v, true);
        out.push(...tag(x.f, 5), ...b);
        break;
      }
      case "bytes":
      case "string":
      case "msg": {
        const body = x.t === "bytes" ? x.v : x.t === "string" ? new TextEncoder().encode(x.v) : encode(x.v);
        out.push(...tag(x.f, 2), ...varintBytes(body.length), ...body);
        break;
      }
      case "packedFixed64": {
        const body = x.v.flatMap((v) => le64((d) => d.setBigUint64(0, v, true)));
        out.push(...tag(x.f, 2), ...varintBytes(body.length), ...body);
        break;
      }
      case "packedDouble": {
        const body = x.v.flatMap((v) => le64((d) => d.setFloat64(0, v, true)));
        out.push(...tag(x.f, 2), ...varintBytes(body.length), ...body);
        break;
      }
    }
  }
  return Uint8Array.from(out);
}

// ---- OTLP/JSON → field lists ---------------------------------------------------------------------

type J = Record<string, unknown>;
const list = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);
const hexBytes = (h: unknown): Uint8Array => Uint8Array.from(Buffer.from(String(h ?? ""), "hex"));
const nanos = (v: unknown): bigint => BigInt(String(v));

function anyValue(v: J): Field[] {
  if ("stringValue" in v) return [{ f: 1, t: "string", v: String(v.stringValue) }];
  if ("boolValue" in v) return [{ f: 2, t: "varint", v: v.boolValue ? 1 : 0 }];
  if ("intValue" in v) return [{ f: 3, t: "varint", v: BigInt(String(v.intValue)) }];
  if ("doubleValue" in v) return [{ f: 4, t: "double", v: Number(v.doubleValue) }];
  if ("arrayValue" in v)
    return [
      {
        f: 5,
        t: "msg",
        v: list((v.arrayValue as J).values).map((x) => ({ f: 1, t: "msg", v: anyValue(x) }) as Field),
      },
    ];
  if ("kvlistValue" in v)
    return [
      {
        f: 6,
        t: "msg",
        v: list((v.kvlistValue as J).values).map((x) => ({ f: 1, t: "msg", v: keyValue(x) }) as Field),
      },
    ];
  if ("bytesValue" in v)
    return [{ f: 7, t: "bytes", v: Uint8Array.from(Buffer.from(String(v.bytesValue), "base64")) }];
  return [];
}

function keyValue(kv: J): Field[] {
  return [
    { f: 1, t: "string", v: String(kv.key) },
    { f: 2, t: "msg", v: anyValue((kv.value ?? {}) as J) },
  ];
}

const attrs = (field: number, a: unknown): Field[] =>
  list(a).map((kv) => ({ f: field, t: "msg", v: keyValue(kv) }));

function resource(r: unknown): Field[] {
  return r ? [{ f: 1, t: "msg", v: attrs(1, (r as J).attributes) }] : [];
}

function scope(s: unknown): Field[] {
  if (!s) return [];
  const o = s as J;
  const v: Field[] = [];
  if (o.name !== undefined) v.push({ f: 1, t: "string", v: String(o.name) });
  if (o.version !== undefined) v.push({ f: 2, t: "string", v: String(o.version) });
  return [{ f: 1, t: "msg", v }];
}

function span(s: J): Field[] {
  const v: Field[] = [
    { f: 1, t: "bytes", v: hexBytes(s.traceId) },
    { f: 2, t: "bytes", v: hexBytes(s.spanId) },
  ];
  if (s.traceState) v.push({ f: 3, t: "string", v: String(s.traceState) });
  if (s.parentSpanId) v.push({ f: 4, t: "bytes", v: hexBytes(s.parentSpanId) });
  v.push({ f: 5, t: "string", v: String(s.name ?? "") });
  if (s.kind) v.push({ f: 6, t: "varint", v: Number(s.kind) });
  v.push({ f: 7, t: "fixed64", v: nanos(s.startTimeUnixNano) });
  if (s.endTimeUnixNano !== undefined) v.push({ f: 8, t: "fixed64", v: nanos(s.endTimeUnixNano) });
  v.push(...attrs(9, s.attributes));
  v.push({ f: 10, t: "varint", v: 0 }); // dropped_attributes_count (unused, skipped by the decoder)
  v.push({ f: 16, t: "fixed32", v: 1 }); // flags (unused)
  const st = s.status as J | undefined;
  if (st) {
    const sv: Field[] = [];
    if (st.message) sv.push({ f: 2, t: "string", v: String(st.message) });
    if (st.code) sv.push({ f: 3, t: "varint", v: Number(st.code) });
    v.push({ f: 15, t: "msg", v: sv });
  }
  return v;
}

export function traceRequestFields(payload: J): Field[] {
  return list(payload.resourceSpans).map((rs) => ({
    f: 1,
    t: "msg",
    v: [
      ...resource(rs.resource),
      ...list(rs.scopeSpans).map(
        (ss) =>
          ({
            f: 2,
            t: "msg",
            v: [...scope(ss.scope), ...list(ss.spans).map((s) => ({ f: 2, t: "msg", v: span(s) }) as Field)],
          }) as Field,
      ),
      { f: 3, t: "string", v: "https://opentelemetry.io/schemas/1.26.0" }, // schema_url (skipped)
    ],
  }));
}

export function encodeTraceRequest(payload: J): Uint8Array {
  return encode(traceRequestFields(payload));
}

function timesOf(dp: J): Field[] {
  const v: Field[] = [];
  if (dp.startTimeUnixNano !== undefined) v.push({ f: 2, t: "fixed64", v: nanos(dp.startTimeUnixNano) });
  if (dp.timeUnixNano !== undefined) v.push({ f: 3, t: "fixed64", v: nanos(dp.timeUnixNano) });
  return v;
}

function numberPoint(dp: J): Field[] {
  const v = [...timesOf(dp)];
  if (dp.asDouble !== undefined) v.push({ f: 4, t: "double", v: Number(dp.asDouble) });
  if (dp.asInt !== undefined) v.push({ f: 6, t: "sfixed64", v: BigInt(String(dp.asInt)) });
  v.push(...attrs(7, dp.attributes));
  return v;
}

function histogramPoint(dp: J, packed: boolean): Field[] {
  const v = [...timesOf(dp)];
  if (dp.count !== undefined) v.push({ f: 4, t: "fixed64", v: BigInt(String(dp.count)) });
  if (dp.sum !== undefined) v.push({ f: 5, t: "double", v: Number(dp.sum) });
  const counts = (dp.bucketCounts as unknown[] | undefined)?.map((x) => BigInt(String(x))) ?? [];
  const bounds = (dp.explicitBounds as unknown[] | undefined)?.map(Number) ?? [];
  if (packed) {
    v.push({ f: 6, t: "packedFixed64", v: counts });
    v.push({ f: 7, t: "packedDouble", v: bounds });
  } else {
    for (const c of counts) v.push({ f: 6, t: "fixed64", v: c });
    for (const b of bounds) v.push({ f: 7, t: "double", v: b });
  }
  v.push(...attrs(9, dp.attributes));
  return v;
}

function summaryPoint(dp: J): Field[] {
  const v = [...timesOf(dp)];
  if (dp.count !== undefined) v.push({ f: 4, t: "fixed64", v: BigInt(String(dp.count)) });
  if (dp.sum !== undefined) v.push({ f: 5, t: "double", v: Number(dp.sum) });
  for (const q of list(dp.quantileValues))
    v.push({
      f: 6,
      t: "msg",
      v: [
        { f: 1, t: "double", v: Number(q.quantile) },
        { f: 2, t: "double", v: Number(q.value) },
      ],
    });
  v.push(...attrs(7, dp.attributes));
  return v;
}

function metric(m: J, packed: boolean): Field[] {
  const v: Field[] = [{ f: 1, t: "string", v: String(m.name) }];
  if (m.description) v.push({ f: 2, t: "string", v: String(m.description) });
  if (m.unit) v.push({ f: 3, t: "string", v: String(m.unit) });
  const pts = (d: J, enc: (p: J) => Field[]): Field[] =>
    list(d.dataPoints).map((p) => ({ f: 1, t: "msg", v: enc(p) }));
  const temporality = (d: J): Field[] =>
    d.aggregationTemporality ? [{ f: 2, t: "varint", v: Number(d.aggregationTemporality) }] : [];
  if (m.gauge) v.push({ f: 5, t: "msg", v: pts(m.gauge as J, numberPoint) });
  if (m.sum) {
    const s = m.sum as J;
    v.push({
      f: 7,
      t: "msg",
      v: [
        ...pts(s, numberPoint),
        ...temporality(s),
        ...(s.isMonotonic ? [{ f: 3, t: "varint", v: 1 } as Field] : []),
      ],
    });
  }
  if (m.histogram) {
    const h = m.histogram as J;
    v.push({ f: 9, t: "msg", v: [...pts(h, (p) => histogramPoint(p, packed)), ...temporality(h)] });
  }
  if (m.summary) v.push({ f: 11, t: "msg", v: pts(m.summary as J, summaryPoint) });
  return v;
}

export function encodeMetricsRequest(payload: J, opts: { packed?: boolean } = {}): Uint8Array {
  const packed = opts.packed ?? true;
  return encode(
    list(payload.resourceMetrics).map((rm) => ({
      f: 1,
      t: "msg",
      v: [
        ...resource(rm.resource),
        ...list(rm.scopeMetrics).map(
          (sm) =>
            ({
              f: 2,
              t: "msg",
              v: [
                ...scope(sm.scope),
                ...list(sm.metrics).map((m) => ({ f: 2, t: "msg", v: metric(m, packed) }) as Field),
              ],
            }) as Field,
        ),
      ],
    })),
  );
}
