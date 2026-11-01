/**
 * End to end: the main request of `sw bugs --concurrency-test` takes path/query/header values from
 * the CLI (`--path-param`, `--query`, `--header`), so `PUT /products/{id}/stock` can be raced
 * without a config file (docs/09-cli-and-api.md §1 `sw bugs`, docs/03-engines/api-bug-hunter.md §6).
 * In-test server on 127.0.0.1:0: only product 7 exists; its stock update is racy
 * (read, yield, write), so a lost update is visible to the interleaved GET reads.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

interface Seen {
  method: string;
  url: string;
  tenant: string | undefined;
}

function productServer(): Promise<{ server: Server; url: string; seen: Seen[] }> {
  let stock = 100;
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "/";
      if (req.method === "POST" && url === "/__reset") {
        stock = 100;
        return send(204, {});
      }
      seen.push({ method: req.method ?? "", url, tenant: req.headers["x-tenant"] as string | undefined });
      const path = url.split("?")[0];
      if (req.method === "GET" && path === "/products/7") return send(200, { id: 7, stock });
      if (req.method === "PUT" && path === "/products/7/stock") {
        const before = stock; // read … yield … write: concurrent updates overwrite each other
        setTimeout(() => {
          stock = before - 1;
          send(200, { id: 7, stock });
        }, 15);
        return;
      }
      send(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, seen });
    });
  });
}

const intParam = (name: string, where: "path" | "query") => ({
  name,
  in: where,
  required: where === "path",
  schema: { type: "integer" },
});

const OPENAPI = {
  openapi: "3.0.3",
  info: { title: "products", version: "1" },
  paths: {
    "/products/{id}": {
      get: {
        operationId: "getProduct",
        parameters: [intParam("id", "path")],
        responses: {
          "200": {
            description: "product",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "stock"],
                  properties: { id: { type: "integer" }, stock: { type: "integer" } },
                },
              },
            },
          },
          "404": { description: "not found" },
        },
      },
    },
    "/products/{id}/stock": {
      put: {
        operationId: "decrementStock",
        parameters: [intParam("id", "path"), intParam("by", "query")],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { delta: { type: "integer" } } },
            },
          },
        },
        responses: { "200": { description: "updated" }, "404": { description: "not found" } },
      },
    },
  },
};

describe("sw bugs --concurrency-test with --path-param / --query / --header", () => {
  let srv: Awaited<ReturnType<typeof productServer>>;
  const dirs: string[] = [];
  beforeAll(async () => {
    srv = await productServer();
  });
  afterAll(async () => {
    await new Promise((r) => srv.server.close(() => r(undefined)));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const project = (): string => {
    const d = mkdtempSync(join(tmpdir(), "sw-cli-cparams-"));
    mkdirSync(join(d, ".git"));
    dirs.push(d);
    writeFileSync(join(d, "openapi.json"), JSON.stringify(OPENAPI));
    writeFileSync(
      join(d, "sw.config.json"),
      JSON.stringify({
        targets: { api: { url: srv.url } },
        hooks: { reset: { http: { method: "POST", url: `${srv.url}/__reset` } } },
      }),
    );
    return d;
  };
  const base = (): string[] => [
    "--yes",
    "--seed",
    "7",
    "bugs",
    "--target",
    srv.url,
    "--openapi",
    "openapi.json",
    "--techniques",
    "concurrency",
    "--allow-mutations",
    "--concurrency-test",
    "PUT /products/{id}/stock",
  ];

  it("sends every burst request to the given id with the query and header; the race is found", async () => {
    srv.seen.length = 0;
    const r = await runCli(
      [
        ...base(),
        "--path-param",
        "id=7",
        "--query",
        "by=1",
        "--header",
        "X-Tenant=acme",
        "--burst",
        "4",
        "--body",
        '{"delta":-1}',
        "--invariant",
        "linearizable:stock",
        "--mix",
        "GET /products/{id} id=7 pointer=/stock phase=before",
        "--mix",
        "GET /products/{id}:2 id=7 pointer=/stock",
        "--mix",
        "GET /products/{id} id=7 pointer=/stock phase=after",
        "--json",
        "--no-history",
      ],
      { cwd: project(), env, timeoutMs: 120_000 },
    );
    const puts = srv.seen.filter((s) => s.method === "PUT");
    expect(puts.length, r.stderr).toBeGreaterThanOrEqual(4);
    for (const p of puts) {
      expect(p.url).toBe("/products/7/stock?by=1");
      expect(p.tenant).toBe("acme");
    }
    const res = JSON.parse(r.stdout).results[0];
    const races = res.findings.filter((f: { ruleId: string }) => f.ruleId === "bugs/race-lost-update");
    expect(races.length, r.stdout).toBe(1);
    expect(races[0].affected[0]).toBe("PUT /products/{id}/stock");
    expect(r.exitCode, r.stderr).toBe(1);
  }, 150_000);

  it.each([
    [["--path-param", "id"], "--path-param"],
    [["--path-param", "=7"], "--path-param"],
    [["--path-param", "sku=7"], "sku"],
    [["--query", "noequals"], "--query"],
    [["--header", "=x"], "--header"],
  ])(
    "bad %j → exit 2 with the expected form, nothing sent",
    async (flags, needle) => {
      srv.seen.length = 0;
      const r = await runCli([...base(), ...flags, "--no-history"], {
        cwd: project(),
        env,
        timeoutMs: 60_000,
      });
      expect(r.exitCode, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain(needle);
      expect(r.stderr).not.toContain("unknown option");
      expect(r.stderr).toContain("Expected");
      expect(srv.seen).toEqual([]);
    },
    90_000,
  );

  it("--path-param without --concurrency-test → exit 2", async () => {
    const r = await runCli(["bugs", "--target", srv.url, "--path-param", "id=7", "--no-history"], {
      cwd: project(),
      env,
      timeoutMs: 60_000,
    });
    expect(r.exitCode, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain("--concurrency-test");
  }, 90_000);
});
