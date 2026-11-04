/**
 * OpenAPI `servers` / Swagger `basePath` → request path prefix (wave 9). Found by testing a real project
 * (gunjit-web/expense-tracker-api: `servers: [{ url: "/api" }]`, paths "/transactions"): every request went
 * to http://host/transactions instead of /api/transactions and came back 404.
 */
import { describe, expect, it } from "vitest";
import { contractBasePath, loadContract, targetWithBasePath } from "../../../src/engines/bugs/contract.js";

describe("contractBasePath", () => {
  it.each([
    [{ openapi: "3.0.3", servers: [{ url: "/api" }] }, "/api"],
    [{ openapi: "3.0.3", servers: [{ url: "/api/" }] }, "/api"],
    [{ openapi: "3.0.3", servers: [{ url: "api/v1" }] }, "/api/v1"],
    [{ openapi: "3.1.0", servers: [{ url: "https://example.com/v2" }] }, "/v2"],
    [{ openapi: "3.0.3", servers: [{ url: "http://127.0.0.1:3000" }] }, ""],
    [{ openapi: "3.0.3", servers: [{ url: "/" }] }, ""],
    [{ openapi: "3.0.3" }, ""],
    [
      {
        openapi: "3.0.3",
        servers: [
          { url: "https://{host}/{base}", variables: { host: { default: "x.io" }, base: { default: "v3" } } },
        ],
      },
      "/v3",
    ],
    [{ swagger: "2.0", basePath: "/legacy" }, "/legacy"],
    [{ swagger: "2.0" }, ""],
  ])("%j → %s", (doc, want) => {
    expect(contractBasePath(doc as Record<string, unknown>)).toBe(want);
  });
});

describe("targetWithBasePath", () => {
  it("adds the base path when the target has none; a target with a path wins", () => {
    expect(targetWithBasePath("http://127.0.0.1:3300", { basePath: "/api" })).toBe(
      "http://127.0.0.1:3300/api",
    );
    expect(targetWithBasePath("http://127.0.0.1:3300/", { basePath: "/api" })).toBe(
      "http://127.0.0.1:3300/api",
    );
    expect(targetWithBasePath("http://127.0.0.1:3300/v9", { basePath: "/api" })).toBe(
      "http://127.0.0.1:3300/v9",
    );
    expect(targetWithBasePath("http://127.0.0.1:3300", { basePath: "" })).toBe("http://127.0.0.1:3300");
    expect(targetWithBasePath("http://127.0.0.1:3300", undefined)).toBe("http://127.0.0.1:3300");
  });

  it("loadContract records the base path", async () => {
    const c = await loadContract({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: "/api" }],
      paths: { "/health": { get: { responses: { "200": { description: "ok" } } } } },
    });
    expect(c.basePath).toBe("/api");
    expect(c.operations.map((o) => o.key)).toEqual(["GET /health"]);
  });
});
