/**
 * Outbound/inbound I/O resilience review (Plan wave 7 §B.2; docs/16-system-design.md §5–6).
 * Each test reproduces a gap found in src/adapters/** before it was fixed:
 *  1. undici executor: `maxBodyBytes` ("max body bytes buffered") was exceeded by up to one whole
 *     chunk — a body of 5000 bytes delivered in one chunk was kept in full with maxBodyBytes 10.
 *  2. OTLP receiver: `spans.push(...parsed.spans)` throws RangeError ("Maximum call stack size
 *     exceeded") for one request with more than ~120k spans; the request was answered 500 and
 *     its spans lost although the body was within maxBodyBytes.
 *  3. OTLP JSONL reader: a line holding an array of >~120k objects hit the same spread limit
 *     and was reported as "not valid JSON".
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUndiciExecutor } from "../../../src/adapters/http/undici-executor.js";
import { payloadsOf } from "../../../src/adapters/telemetry/otlp.js";
import { startOtlpReceiver } from "../../../src/adapters/telemetry/receiver.js";

describe("undici executor body cap", () => {
  let server: http.Server;
  let origin = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/one-chunk") res.writeHead(200).end("x".repeat(5000));
      else if (req.url === "/many-chunks") {
        res.writeHead(200);
        let n = 0;
        const tick = (): void => {
          if (n++ >= 20) return void res.end();
          res.write("y".repeat(700));
          setImmediate(tick);
        };
        tick();
      } else res.writeHead(200).end("small");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));

  for (const path of ["/one-chunk", "/many-chunks"]) {
    it(`keeps at most maxBodyBytes of ${path} and still counts every byte`, async () => {
      const ex = createUndiciExecutor({ maxBodyBytes: 1000 });
      try {
        const r = await ex.execute({ origin, method: "GET", path, readBody: true });
        expect(r.error).toBeUndefined();
        expect(r.bytesIn).toBe(path === "/one-chunk" ? 5000 : 14_000);
        expect(r.body?.length).toBe(1000);
      } finally {
        await ex.close();
      }
    });
  }

  it("a body smaller than the cap is kept whole", async () => {
    const ex = createUndiciExecutor({ maxBodyBytes: 1000 });
    try {
      const r = await ex.execute({ origin, method: "GET", path: "/small", readBody: true });
      expect(r.body?.toString()).toBe("small");
    } finally {
      await ex.close();
    }
  });
});

const BIG = 150_000; // above V8's ~120k spread-argument limit

function bigTracePayload(n: number): string {
  const spans: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = i.toString(16).padStart(16, "0");
    spans.push(
      `{"traceId":"0000000000000000${id}","spanId":"${id}","name":"s","startTimeUnixNano":"1000","endTimeUnixNano":"2000"}`,
    );
  }
  return `{"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"spans":[${spans.join(",")}]}]}]}`;
}

describe("OTLP receiver with a very large batch", () => {
  it(`accepts one request with ${BIG} spans (no spread-argument overflow)`, async () => {
    const rx = await startOtlpReceiver({ maxBodyBytes: 64 * 1024 * 1024, maxSpans: 1_000_000 });
    try {
      const body = bigTracePayload(BIG);
      const res = await fetch(`${rx.url}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      expect(rx.stats().spans).toBe(BIG);
      expect(rx.spans().length).toBe(BIG);
    } finally {
      await rx.close();
    }
  }, 60_000);

  it("keeps only the newest maxSpans when a batch overflows the buffer", async () => {
    const rx = await startOtlpReceiver({ maxBodyBytes: 64 * 1024 * 1024, maxSpans: 1000 });
    try {
      const res = await fetch(`${rx.url}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bigTracePayload(5000),
        signal: AbortSignal.timeout(30_000),
      });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      expect(rx.spans().length).toBe(1000);
      expect(rx.stats().droppedSpans).toBe(4000);
    } finally {
      await rx.close();
    }
  }, 30_000);
});

describe("OTLP JSONL reader", () => {
  it(`reads a JSONL line holding an array of ${BIG} objects`, () => {
    const line = `[${new Array(BIG).fill('{"resourceSpans":[]}').join(",")}]`;
    const warnings: string[] = [];
    // Two lines so the whole text is not valid JSON and the JSONL path is taken.
    const out = payloadsOf(`${line}\n{"resourceSpans":[]}`, warnings);
    expect(warnings).toEqual([]);
    expect(out.length).toBe(BIG + 1);
  });
});
