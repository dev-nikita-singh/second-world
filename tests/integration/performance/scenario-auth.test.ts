/**
 * Scenario-level auth end to end: tokens go only on their own scenario's requests and never into
 * the result; the shop-express example config (checkout uses `auth: "user"`) validates.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPerformance } from "../../../src/engines/performance/index.js";
import { runCli } from "../../helpers/cli.js";

let server: http.Server;
let base = "";
const seen = new Map<string, Set<string>>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] as string;
    const auth = req.headers.authorization ?? "<none>";
    let s = seen.get(path);
    if (!s) {
      s = new Set();
      seen.set(path, s);
    }
    s.add(auth);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("scenario auth (integration)", () => {
  it("mixed scenarios: each token only on its own scenario's requests, absent from the result", async () => {
    const res = await runPerformance({
      target: base,
      iterations: 60,
      vus: 3,
      seed: 7,
      auth: { type: "bearer", token: "section-tok-777" },
      scenarios: [
        { name: "browse", weight: 1, steps: [{ path: "/browse" }] },
        {
          name: "checkout",
          weight: 1,
          auth: { type: "bearer", token: "user-tok-999" },
          steps: [{ path: "/checkout" }],
        },
        {
          name: "anon",
          weight: 1,
          auth: { type: "header", name: "x-api-key", value: "key-555" },
          steps: [{ path: "/anon" }],
        },
      ],
    });
    expect(res.data?.totals.failed).toBe(0);
    expect([...(seen.get("/browse") ?? [])]).toEqual(["Bearer section-tok-777"]);
    expect([...(seen.get("/checkout") ?? [])]).toEqual(["Bearer user-tok-999"]);
    // the scenario's own header auth replaces the section bearer entirely
    expect([...(seen.get("/anon") ?? [])]).toEqual(["<none>"]);
    const json = JSON.stringify(res);
    for (const secret of ["section-tok-777", "user-tok-999", "key-555"]) expect(json).not.toContain(secret);
  });

  it('`sw config validate` accepts the shop-express example (scenario auth: "user")', async () => {
    const r = await runCli(["config", "validate", "-c", "examples/shop-express/sw.config.ts"]);
    expect(r.stderr + r.stdout).not.toMatch(/Unrecognized key/);
    expect(r.exitCode).toBe(0);
  });
});
