/**
 * `sw model` Prometheus scrapes: the Safety Guard checks the configured URL only, so a redirect must
 * never be followed to another place (residual risk from sw-sec-w8, wave 8).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildModel } from "../../../src/engines/model/index.js";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  return new Promise((r) =>
    s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)),
  );
}

describe("model prometheus scrape", () => {
  it("does not follow a redirect; the scrape fails with a limitation", async () => {
    let hits = 0;
    const target = await listen((_q, res) => {
      hits++;
      res.end("# TYPE x counter\nx 1\n");
    });
    const redirector = await listen((_q, res) => {
      res.writeHead(302, { location: `${target}/metrics` });
      res.end();
    });
    const r = await buildModel({ prometheus: [{ url: `${redirector}/metrics` }] }, {});
    expect(hits).toBe(0);
    const lim = r.limitations.find((l) => l.code === "MODEL_PROMETHEUS_FAILED");
    expect(lim?.message).toMatch(/redirect not followed/);
  });

  it("a normal scrape still works", async () => {
    const url = await listen((_q, res) => {
      res.end('# TYPE http_requests_total counter\nhttp_requests_total{route="/a",status="200"} 1\n');
    });
    const r = await buildModel({ prometheus: [{ url: `${url}/metrics` }] }, {});
    expect(r.limitations.find((l) => l.code === "MODEL_PROMETHEUS_FAILED")).toBeUndefined();
  });
});
