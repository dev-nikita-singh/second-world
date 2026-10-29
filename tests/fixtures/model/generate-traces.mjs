// Deterministic OTLP/JSON fixture generator for the shop-express topology.
import { writeFileSync } from "node:fs";

const out = process.argv[2];
const T0 = 1761700000000000000n; // ns
let seq = 1;
const hex = (n, len) => n.toString(16).padStart(len, "0");
const ns = (ms) => (T0 + BigInt(Math.round(ms * 1e6))).toString();
const attr = (k, v) => ({
  key: k,
  value:
    typeof v === "number"
      ? Number.isInteger(v)
        ? { intValue: String(v) }
        : { doubleValue: v }
      : typeof v === "boolean"
        ? { boolValue: v }
        : { stringValue: v },
});
const shop = [];
const pay = [];
function span(list, traceId, parent, name, kind, start, end, attrs = {}, status) {
  const spanId = hex(seq++, 16);
  const s = {
    traceId,
    spanId,
    name,
    kind,
    startTimeUnixNano: ns(start),
    endTimeUnixNano: ns(end),
    attributes: Object.entries(attrs).map(([k, v]) => attr(k, v)),
  };
  if (parent) s.parentSpanId = parent;
  if (status) s.status = status;
  list.push(s);
  return spanId;
}
const db = (tid, parent, op, a, b) =>
  span(shop, tid, parent, `Db.${op}`, 3, a, b, {
    "db.system": "other_sql",
    "db.name": "Db",
    "db.operation": op,
  });
let base = 0;
let tn = 1;
const tid = () => hex(tn++, 32);
const srv = (route, method, code = 200) => ({
  "http.request.method": method,
  "http.route": route,
  "server.address": "127.0.0.1",
  "server.port": 3000,
  "http.response.status_code": code,
});
// GET /products/:id ×10: two sequential db reads
for (let i = 0; i < 10; i++) {
  const t = tid();
  const o = base;
  const d = i % 3;
  const root = span(shop, t, null, "GET /products/:id", 2, o, o + 12 + d, srv("/products/:id", "GET"));
  db(t, root, "SELECT", o + 1, o + 3);
  db(t, root, "SELECT", o + 3, o + 5 + d);
  base += 100;
}
// GET /products ×3: list then 3 PARALLEL review reads (N+1, concurrent)
for (let i = 0; i < 3; i++) {
  const t = tid();
  const o = base;
  const root = span(shop, t, null, "GET /products", 2, o, o + 20, srv("/products", "GET"));
  db(t, root, "SELECT", o + 1, o + 3);
  db(t, root, "SELECT", o + 4, o + 10);
  db(t, root, "SELECT", o + 4, o + 16);
  db(t, root, "SELECT", o + 4, o + 9);
  base += 100;
}
// POST /orders ×5: reads/writes + payments call (dominant), last one errors (500)
for (let i = 0; i < 5; i++) {
  const t = tid();
  const o = base;
  const err = i === 4;
  const root = span(
    shop,
    t,
    null,
    "POST /orders",
    2,
    o,
    o + 100,
    srv("/orders", "POST", err ? 500 : 201),
    err ? { code: 2, message: "payment failed" } : undefined,
  );
  db(t, root, "SELECT", o + 1, o + 3);
  db(t, root, "UPDATE", o + 3, o + 5);
  db(t, root, "INSERT", o + 5, o + 7);
  const c = span(shop, t, root, "POST", 3, o + 8, o + 90, {
    "http.request.method": "POST",
    "peer.service": "payments",
    "server.address": "127.0.0.1",
    "server.port": 4010,
    "url.full": "http://127.0.0.1:4010/charges",
    "http.response.status_code": err ? 503 : 201,
  });
  span(pay, t, c, "POST /charges", 2, o + 10, o + 88, {
    "http.request.method": "POST",
    "http.route": "/charges",
    "server.address": "127.0.0.1",
    "server.port": 4010,
    "http.response.status_code": err ? 503 : 201,
  });
  db(t, root, "UPDATE", o + 91, o + 93);
  base += 200;
}
// Orphan: a db span whose parent was never exported.
{
  const t = tid();
  span(shop, t, "ffffffffffffffff", "Db.SELECT", 3, base, base + 2, {
    "db.system": "other_sql",
    "db.name": "Db",
    "db.operation": "SELECT",
  });
}
// Out-of-order: reverse span order inside the scope (children before parents).
shop.reverse();
const res = (svc, spans) => ({
  resource: {
    attributes: [
      attr("service.name", svc),
      attr("service.version", "1.0.0"),
      { key: "host.arch", value: { arrayValue: { values: [{ stringValue: "x64" }] } } },
    ],
  },
  scopeSpans: [{ scope: { name: "fixture" }, spans }],
});
writeFileSync(`${out}/shop-traces.json`, JSON.stringify({ resourceSpans: [res("shop", shop)] }, null, 1));
writeFileSync(
  `${out}/payments-traces.jsonl`,
  `${JSON.stringify({ resourceSpans: [res("payments-fake", pay.slice(0, 3))] })}\n${JSON.stringify({ resourceSpans: [res("payments-fake", pay.slice(3))] })}\n`,
);
