/**
 * End to end: a mixed-operation race found from the CLI alone (`sw bugs --concurrency-test … --mix …`),
 * against an in-test HTTP server on 127.0.0.1:0 (docs/03-engines/api-bug-hunter.md §6).
 * The racy server loses updates (read stock, yield, write stock - 1) while every order still
 * returns 201, so only the interleaved stock reads reveal the bug. The atomic server is the control.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../helpers/cli.js";
import { validateHar12 } from "./har-validate.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

function stockServer(racy: boolean): Promise<{ server: Server; url: string }> {
  let stock = 100;
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString("utf8");
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/__reset") {
        stock = 100;
        return send(204, {});
      }
      if (req.method === "GET" && req.url === "/products/1") return send(200, { id: 1, stock });
      if (req.method === "POST" && req.url === "/orders") {
        if (!racy) {
          if (stock < 1) return send(409, { error: "out of stock" });
          stock -= 1;
          return send(201, { id: `o${stock}` });
        }
        const seen = stock; // read … yield … write: concurrent orders overwrite each other
        setTimeout(() => {
          if (seen < 1) return send(409, { error: "out of stock" });
          stock = seen - 1;
          send(201, { id: `o${seen}` });
        }, 15);
        return;
      }
      send(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const OPENAPI = {
  openapi: "3.0.3",
  info: { title: "stock", version: "1" },
  paths: {
    "/orders": {
      post: {
        operationId: "createOrder",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["productId", "qty"],
                properties: { productId: { type: "integer" }, qty: { type: "integer", minimum: 1 } },
              },
            },
          },
        },
        responses: { "201": { description: "created" }, "409": { description: "out of stock" } },
      },
    },
    "/products/{id}": {
      get: {
        operationId: "getProduct",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
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
  },
};

async function runMixed(url: string, dir: string) {
  writeFileSync(join(dir, "openapi.json"), JSON.stringify(OPENAPI));
  writeFileSync(
    join(dir, "sw.config.json"),
    JSON.stringify({
      targets: { api: { url } },
      hooks: { reset: { http: { method: "POST", url: `${url}/__reset` } } },
    }),
  );
  const r = await runCli(
    [
      "--yes",
      "--seed",
      "7",
      "bugs",
      "--target",
      url,
      "--openapi",
      "openapi.json",
      "--techniques",
      "concurrency",
      "--allow-mutations",
      "--concurrency-test",
      "POST /orders",
      "--burst",
      "4",
      "--body",
      '{"productId":1,"qty":1}',
      "--invariant",
      "linearizable:stock",
      "--mix",
      "GET /products/{id} id=1 pointer=/stock phase=before",
      "--mix",
      "GET /products/{id}:2 id=1 pointer=/stock",
      "--mix",
      "GET /products/{id} id=1 pointer=/stock phase=after",
      "--json",
      "--no-history",
    ],
    { cwd: dir, env, timeoutMs: 120_000 },
  );
  return r;
}

describe("sw bugs --mix finds a mixed-operation race end to end", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  let racyUrl = "";
  let atomicUrl = "";
  beforeAll(async () => {
    const a = await stockServer(true);
    const b = await stockServer(false);
    servers.push(a.server, b.server);
    racyUrl = a.url;
    atomicUrl = b.url;
  });
  afterAll(async () => {
    for (const s of servers) await new Promise((r) => s.close(() => r(undefined)));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const tempDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "sw-cli-mix-"));
    mkdirSync(join(d, ".git"));
    dirs.push(d);
    return d;
  };

  it("racy server: race-lost-update, reproduced, exit 1, HAR with the interleaved reads", async () => {
    const r = await runMixed(racyUrl, tempDir());
    expect(r.exitCode, r.stderr).toBe(1);
    const res = JSON.parse(r.stdout).results[0];
    const races = res.findings.filter((f: { ruleId: string }) => f.ruleId === "bugs/race-lost-update");
    expect(races.length).toBe(1);
    expect(races[0].classification).toBe("reproduced-defect");
    expect(races[0].affected[0]).toBe("POST /orders");
    const harPath = (res.artifacts as { path: string }[]).find((a) =>
      a.path.endsWith("reproduction.har"),
    )?.path;
    expect(harPath).toBeDefined();
    const har = JSON.parse(readFileSync(harPath as string, "utf8"));
    expect(validateHar12(har)).toEqual([]);
    const entries = har.log.entries as { request: { method: string; url: string } }[];
    expect(entries.filter((e) => e.request.method === "POST").length).toBe(4);
    expect(
      entries.filter((e) => e.request.method === "GET" && e.request.url.endsWith("/products/1")).length,
    ).toBe(4);
  }, 150_000);

  it("atomic server (control): no race finding, exit 0", async () => {
    const r = await runMixed(atomicUrl, tempDir());
    const res = JSON.parse(r.stdout).results[0];
    expect(res.findings.filter((f: { ruleId: string }) => f.ruleId === "bugs/race-lost-update")).toEqual([]);
    expect(r.exitCode, r.stderr).toBe(0);
  }, 150_000);
});
