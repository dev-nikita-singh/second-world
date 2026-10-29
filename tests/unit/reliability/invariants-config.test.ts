/** `reliability.invariants` + route `idempotency` flow from sw.config through the World into the engine input. */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/core/config/loader.js";
import { buildReliabilityInput } from "../../../src/core/world.js";
import { parseReliabilityInput } from "../../../src/engines/reliability/index.js";

describe("invariants from sw.config", () => {
  it("config.reliability.invariants and route idempotency reach the parsed engine input (auth resolved for headersFrom)", async () => {
    const cfg = await loadConfig({
      env: {},
      userConfig: false,
      inline: {
        targets: { api: { url: "http://127.0.0.1:3000" } },
        auth: { alice: { type: "bearer", token: { env: "TOK" } } },
        reliability: {
          dependencies: { payments: { upstream: "http://127.0.0.1:4010" } },
          workload: {
            routes: [
              { name: "orders", method: "POST", path: "/orders", auth: "alice", idempotency: { retries: 3 } },
            ],
          },
          invariants: [
            {
              type: "no-duplicates",
              collection: "GET /orders",
              key: "idempotencyKey",
              headersFrom: "orders",
            },
            { type: "count-matches", collection: "/orders", headersFrom: "orders" },
            { type: "conserved", terms: [{ collection: "/products", field: "stock" }], perOperation: -1 },
          ],
        },
      },
    });
    const raw = buildReliabilityInput(
      cfg,
      { scenario: "dependency-timeout", dependency: "payments" },
      { env: { TOK: "alice-secret-token" } },
    );
    const input = parseReliabilityInput(raw);
    expect(input.target).toBe("http://127.0.0.1:3000");
    expect(input.invariants.map((i) => i.type)).toEqual(["no-duplicates", "count-matches", "conserved"]);
    expect(input.invariants[0]).toMatchObject({
      key: "idempotencyKey",
      headersFrom: "orders",
      scope: "workload",
    });
    expect(input.invariants[2]).toMatchObject({ perOperation: -1, tolerance: 0 });
    const route = input.workload.routes[0];
    expect(route?.idempotency).toMatchObject({ header: "Idempotency-Key", retries: 3 });
    // the route's auth is resolved, so headersFrom: "orders" reuses the credentials
    expect(route?.headers.authorization).toBe("Bearer alice-secret-token");
  });

  it("call input overrides the config's invariants", async () => {
    const cfg = await loadConfig({
      env: {},
      userConfig: false,
      inline: {
        targets: { api: { url: "http://127.0.0.1:3000" } },
        reliability: { invariants: [{ type: "count-matches", collection: "/a", routes: ["x"] }] },
      },
    });
    const raw = buildReliabilityInput(cfg, { scenario: "s", dependency: "d", invariants: [] });
    expect(parseReliabilityInput(raw).invariants).toEqual([]);
    const fromCfg = buildReliabilityInput(cfg, { scenario: "s", dependency: "d" });
    expect(parseReliabilityInput(fromCfg).invariants).toHaveLength(1);
  });
});
