/** F10: reliability workload `route.auth: "<role>"` → headers from config.auth. */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/core/config/loader.js";
import { authHeadersFor, buildReliabilityInput } from "../../../src/core/world.js";
import { parseReliabilityInput } from "../../../src/engines/reliability/index.js";

async function cfg() {
  return loadConfig({
    env: {},
    userConfig: false,
    inline: {
      targets: { api: { url: "http://127.0.0.1:3000" } },
      auth: {
        user: { type: "bearer", token: { env: "TOK" } },
        ops: { type: "basic", username: "ops", password: "pw-123" },
        svc: { type: "header", name: "X-Api-Key", value: "key-9" },
        sso: { type: "oauth2-client-credentials", tokenUrl: "x" },
        missing: { type: "bearer", token: { env: "NOT_SET" } },
      },
      reliability: {
        dependencies: { payments: { injector: "builtin", upstream: "http://127.0.0.1:4010", listen: 0 } },
        workload: {
          routes: [
            { name: "orders", method: "POST", path: "/orders", auth: "user", headers: { "content-type": "application/json" } },
            { name: "admin", path: "/admin", auth: "ops" },
            { name: "svc", path: "/svc", auth: "svc" },
            { name: "explicit", path: "/x", auth: "user", headers: { Authorization: "Bearer explicit" } },
            { name: "nope", path: "/n", auth: "ghost" },
            { name: "oauth", path: "/o", auth: "sso" },
            { name: "nosecret", path: "/s", auth: "missing" },
            { name: "plain", path: "/p" },
          ],
        },
      },
    },
  });
}

describe("reliability route auth roles", () => {
  it("authHeadersFor: bearer ({env}), basic, header; unsupported/missing → undefined", async () => {
    const c = await cfg();
    expect(authHeadersFor(c, "user", { TOK: "alice" })).toEqual({ authorization: "Bearer alice" });
    expect(authHeadersFor(c, "ops")).toEqual({ authorization: `Basic ${Buffer.from("ops:pw-123").toString("base64")}` });
    expect(authHeadersFor(c, "svc")).toEqual({ "x-api-key": "key-9" });
    expect(authHeadersFor(c, "sso")).toBeUndefined();
    expect(authHeadersFor(c, "ghost")).toBeUndefined();
    expect(authHeadersFor(c, "missing", {})).toBeUndefined();
  });

  it("buildReliabilityInput resolves roles into headers; explicit headers win; unresolved roles stay (engine adds a limitation)", async () => {
    const c = await cfg();
    const input = buildReliabilityInput(c, { scenario: "dependency-latency", dependency: "payments" }, { env: { TOK: "alice" } });
    const routes = (input.workload as { routes: Array<Record<string, unknown>> }).routes;
    const by = (n: string) => routes.find((r) => r.name === n) as Record<string, unknown>;
    expect(by("orders")).toEqual({
      name: "orders",
      method: "POST",
      path: "/orders",
      headers: { "content-type": "application/json", authorization: "Bearer alice" },
    });
    expect(by("admin").headers).toMatchObject({ authorization: expect.stringMatching(/^Basic /) });
    expect(by("svc").headers).toEqual({ "x-api-key": "key-9" });
    expect(by("explicit").headers).toEqual({ Authorization: "Bearer explicit" });
    expect(by("nope").auth).toBe("ghost");
    expect(by("oauth").auth).toBe("sso");
    expect(by("nosecret").auth).toBe("missing");
    expect(by("plain")).toEqual({ name: "plain", path: "/p" });
    // the engine schema accepts the optional auth field
    expect(() => parseReliabilityInput(input)).not.toThrow();
  });
});
