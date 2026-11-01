/**
 * Hand-written node:http dispatch (framework "node-http") — docs/03-engines/architecture-inspector.md
 * §1.3. Found on examples/conduit-api: inspect saw no routes (ARCH_NO_ROUTES) and ARCH005 named the
 * enclosing function instead of the route.
 */
import { describe, expect, it } from "vitest";
import { regexToPath } from "../../../src/engines/architecture/analyzer/ts/extractors/node-http.js";
import { byRule, inspectFiles } from "./helpers.js";

type Routes = { routes: { method: string; path: string; framework: string; handler?: string }[] };
const ids = (d: Routes) => d.routes.map((r) => `${r.method} ${r.path}`).sort();
const confidence = (r: { limitations: { code: string }[] }) => r.limitations.map((l) => l.code);

const DB = `
import { DatabaseSync } from "node:sqlite";
export const db = new DatabaseSync(":memory:");
export function listOrders() { return db.prepare("SELECT * FROM orders").all(); }
export function getOrder(id: string) { return db.prepare("SELECT * FROM orders WHERE id = ?").get(id); }
export function addOrder() { return db.prepare("INSERT INTO orders DEFAULT VALUES").run(); }
`;

describe("regexToPath", () => {
  it.each([
    ["^\\/orders$", "/orders"],
    ["^/orders/?$", "/orders"],
    ["^\\/orders\\/(?<id>\\d+)$", "/orders/:id"],
    ["^\\/orders\\/([^/]+)\\/items\\/(\\d+)$", "/orders/:p1/items/:p2"],
    ["^\\/static\\/.*$", "/static/*"],
    ["^\\/a\\.json$", "/a.json"],
  ])("%s → %s", (src, want) => {
    expect(regexToPath(src)).toBe(want);
  });

  it.each([["orders$"], ["^\\/(a|b)$".replace("(", "(?:")], ["^\\/x\\d$"], ["^\\/[ab]$"], ["^\\/a|b$"]])(
    "%s is not a path",
    (src) => {
      expect(regexToPath(src)).toBeUndefined();
    },
  );
});

describe("node:http dispatch patterns", () => {
  it("project router class: router.get/post(path, handler) and r.add(METHOD, path, handler) — conduit style", async () => {
    const { data, result } = await inspectFiles({
      "src/router.ts": `
import type { IncomingMessage, ServerResponse } from "node:http";
export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export class Router {
  private readonly routes: { method: string; pattern: string; handler: Handler }[] = [];
  add(method: string, pattern: string, handler: Handler): this { this.routes.push({ method, pattern, handler }); return this; }
  get(p: string, h: Handler): this { return this.add("GET", p, h); }
  post(p: string, h: Handler): this { return this.add("POST", p, h); }
}
`,
      "src/routes.ts": `
import type { Router } from "./router.js";
import { db, listOrders } from "./db.js";
export function orderRoutes(r: Router): void {
  r.get("/orders", async (_req, res) => {
    for (const o of listOrders() as { id: string }[]) db.prepare("SELECT * FROM items WHERE order_id = ?").all(o.id);
    res.end();
  });
  r.add("DELETE", "/orders/:id", async (_req, res) => { res.end(); });
}
`,
      "src/server.ts": `
import { createServer } from "node:http";
import { Router } from "./router.js";
import { orderRoutes } from "./routes.js";
const router = new Router();
router.post("/__test/reset", async (_req, res) => { res.end(); });
orderRoutes(router);
export const server = createServer(() => {});
`,
      "src/db.ts": DB,
    });
    expect(ids(data)).toEqual(["DELETE /orders/:id", "GET /orders", "POST /__test/reset"]);
    expect(new Set(data.routes.map((r) => r.framework))).toEqual(new Set(["node-http"]));
    expect(data.project.frameworks).toEqual(["node-http"]);
    expect(confidence(result)).not.toContain("ARCH_NO_ROUTES");
    // ARCH005 now names the route that reaches the loop.
    const n1 = byRule(result, "ARCH005");
    expect(n1.length).toBe(1);
    expect(n1[0]?.title).toContain("GET /orders");
    expect(data.edges.find((e) => e.from === "route:GET /orders")?.evidence[0]).toMatchObject({
      file: "src/routes.ts",
      line: 5,
      extractor: "framework/node-http",
    });
  });

  it("library receivers are not routers: Map.get, an HTTP client with an options object, node:http.get", async () => {
    const { data } = await inspectFiles({
      "src/x.ts": `
import http from "node:http";
const cache = new Map<string, () => void>();
cache.set("/orders", () => {});
cache.get("/orders");
http.get("/orders", (res) => res.resume());
const client = { get(path: string, opts: { headers: Record<string, string> }) { return [path, opts]; } };
client.get("/orders", { headers: {} });
`,
    });
    expect(ids(data)).toEqual([]);
  });

  it('route tables: { "GET /x": h }, [{ method, pattern: /re/, handler }], [["POST", "/x", h]]', async () => {
    const { data } = await inspectFiles({
      "src/server.ts": `
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { listOrders, getOrder, addOrder } from "./db.js";
type H = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void;
async function list(_q: IncomingMessage, s: ServerResponse) { s.end(JSON.stringify(listOrders())); }
async function one(_q: IncomingMessage, s: ServerResponse, p: Record<string, string>) { s.end(JSON.stringify(getOrder(p.id as string))); }
const ORDER_RE = /^\\/orders\\/(?<id>[^/]+)$/;
const table: { method: string; pattern: RegExp; handler: H }[] = [
  { method: "GET", pattern: /^\\/orders$/, handler: list },
  { method: "GET", pattern: ORDER_RE, handler: one },
];
const keyed: Record<string, H> = {
  "GET /healthz": (_q, s) => s.end("ok"),
  "DELETE /orders/:id": async (_q, s) => { s.end(); },
};
const rows: [string, string, H][] = [["POST", "/orders", (_q, s) => { addOrder(); s.end(); }]];
export const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  for (const r of table) { const m = r.pattern.exec(url.pathname); if (m && r.method === req.method) return r.handler(req, res, m.groups ?? {}); }
  const h = keyed[\`\${req.method} \${url.pathname}\`]; if (h) return h(req, res, {});
  void rows;
});
`,
      "src/db.ts": DB,
    });
    expect(ids(data)).toEqual([
      "DELETE /orders/:id",
      "GET /healthz",
      "GET /orders",
      "GET /orders/:id",
      "POST /orders",
    ]);
    const one = data.routes.find((r) => r.path === "/orders/:id" && r.method === "GET");
    expect(one?.handler).toBe("src/server.ts#one");
    // reachability: GET /orders/:id → one → getOrder → sqlite
    expect(
      data.edges.some((e) => e.from === "route:GET /orders/:id" && e.to === "fn:src/server.ts#one"),
    ).toBe(true);
  });

  it("if-chains: method && path, regex exec bound to a const, nested method-in-path and path-in-method", async () => {
    const { data } = await inspectFiles({
      "src/server.ts": `
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { listOrders, getOrder, addOrder } from "./db.js";
async function list(res: ServerResponse) { res.end(JSON.stringify(listOrders())); }
async function create(res: ServerResponse) { addOrder(); res.end(); }
async function show(res: ServerResponse, id: string) { res.end(JSON.stringify(getOrder(id))); }
export async function dispatch(req: IncomingMessage, res: ServerResponse) {
  const method = req.method ?? "GET";
  const { pathname } = new URL(req.url ?? "/", "http://x");
  if (pathname === "/healthz") { res.end("ok"); return; }
  if (method === "GET" && pathname === "/orders") return list(res);
  if (req.method === "POST" && pathname === "/orders") { await create(res); return; }
  const m = /^\\/orders\\/(\\d+)$/.exec(pathname);
  if (m && method === "GET") return show(res, m[1] as string);
  if (pathname === "/admin/stats") {
    if (method === "GET") { res.end("{}"); return; }
    if (method === "DELETE") { res.end(); return; }
  }
  if (method === "PUT") {
    if (pathname.match(/^\\/orders\\/(?<id>\\d+)\\/note$/)) { res.end(); return; }
  }
  res.statusCode = 404; res.end();
}
export const server = createServer((q, s) => void dispatch(q, s));
`,
      "src/db.ts": DB,
    });
    expect(ids(data)).toEqual([
      "ALL /healthz",
      "DELETE /admin/stats",
      "GET /admin/stats",
      "GET /orders",
      "GET /orders/:p1",
      "POST /orders",
      "PUT /orders/:id/note",
    ]);
    const byId = new Map(data.routes.map((r) => [`${r.method} ${r.path}`, r]));
    expect(byId.get("GET /orders")?.handler).toBe("src/server.ts#list");
    expect(byId.get("POST /orders")?.handler).toBe("src/server.ts#create");
    expect(byId.get("GET /orders/:p1")?.handler).toBe("src/server.ts#show");
    expect(byId.get("ALL /healthz")?.handler).toBe("src/server.ts#dispatch");
  });

  it("switch on method, on path, and on a method+path template key", async () => {
    const { data } = await inspectFiles({
      "src/server.ts": `
import type { IncomingMessage, ServerResponse } from "node:http";
import { listOrders, addOrder } from "./db.js";
async function list(res: ServerResponse) { res.end(JSON.stringify(listOrders())); }
export async function a(req: IncomingMessage, res: ServerResponse) {
  const path = req.url ?? "/";
  switch (req.method) {
    case "GET":
      if (path === "/orders") return list(res);
      break;
    case "POST":
      switch (path) {
        case "/orders": addOrder(); res.end(); return;
      }
      break;
  }
}
export async function b(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  switch (\`\${req.method} \${url.pathname}\`) {
    case "GET /healthz": res.end("ok"); return;
    case "DELETE /orders": res.end(); return;
    default: res.statusCode = 404; res.end();
  }
}
`,
      "src/db.ts": DB,
    });
    expect(ids(data)).toEqual(["DELETE /orders", "GET /healthz", "GET /orders", "POST /orders"]);
  });

  it("no false routes from ordinary code: string compares outside dispatchers, fetch options", async () => {
    const { data } = await inspectFiles({
      "src/x.ts": `
export function kind(path: string) { if (path === "/tmp") return "tmp"; return "other"; }
export function label(method: string) { if (method === "GET") return "read"; return "write"; }
export async function call(base: string) {
  return fetch(base + "/charges", { method: "POST", signal: AbortSignal.timeout(1000) });
}
export const opts = { method: "POST", path: "/charges", headers: {} };
`,
    });
    expect(ids(data)).toEqual([]);
  });

  it("frameworks filter: node-http can be disabled", async () => {
    const { data } = await inspectFiles(
      {
        "src/server.ts": `
import type { IncomingMessage, ServerResponse } from "node:http";
export async function d(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "GET" && req.url === "/x") res.end();
}
`,
      },
      { frameworks: ["express"] },
    );
    expect(ids(data)).toEqual([]);
  });
});

describe("route-level rules on node-http apps", () => {
  it("ARCH007: optional-auth handlers are public; a shared /api prefix is not one sibling group; login is not a guard", async () => {
    const { result, data } = await inspectFiles({
      "src/auth.ts": `
export async function requireUser(_req: unknown) { return { id: 1 }; }
export async function optionalUser(_req: unknown) { return undefined; }
`,
      "src/sessions.ts": `export class Sessions { async newSession(_u: number) { return "t"; } }`,
      "src/router.ts": `
export type H = (req: unknown) => Promise<void>;
export class Router { get(_p: string, _h: H) { return this; } post(_p: string, _h: H) { return this; } delete(_p: string, _h: H) { return this; } }
`,
      "src/routes.ts": `
import { optionalUser, requireUser } from "./auth.js";
import type { Router } from "./router.js";
import { Sessions } from "./sessions.js";
const sessions = new Sessions();
export function routes(r: Router) {
  r.get("/api/articles", async (req) => { await optionalUser(req); });
  r.post("/api/articles", async (req) => { await requireUser(req); });
  r.delete("/api/articles/:id", async (req) => { await requireUser(req); });
  r.post("/api/users/login", async () => { await sessions.newSession(1); });
  r.post("/api/users", async () => {});
  r.get("/api/user", async (req) => { await requireUser(req); });
}
`,
    });
    expect(data.routes.find((r) => r.path === "/api/users/login")?.auth).toBe(false);
    expect(byRule(result, "ARCH007")).toEqual([]);
  });

  it("ARCH008 counts repository wrappers over one driver datastore as one system", async () => {
    const { result } = await inspectFiles({
      "src/db.ts": `
import { DatabaseSync } from "node:sqlite";
export class Db { private readonly sql = new DatabaseSync(":memory:"); all(q: string) { return this.sql.prepare(q).all(); } }
`,
      "src/repos.ts": `
import type { Db } from "./db.js";
export class UserRepository { constructor(private readonly db: Db) {} list() { return this.db.all("SELECT 1"); } }
export class ArticleRepository { constructor(private readonly db: Db) {} list() { return this.db.all("SELECT 2"); } }
export class CommentRepository { constructor(private readonly db: Db) {} list() { return this.db.all("SELECT 3"); } }
`,
      "src/routes.ts": `
import type { ArticleRepository, CommentRepository, UserRepository } from "./repos.js";
export class Router { get(_p: string, _h: () => Promise<void>) { return this; } }
export function routes(r: Router, u: UserRepository, a: ArticleRepository, c: CommentRepository) {
  r.get("/api/feed", async () => { u.list(); a.list(); c.list(); });
}
`,
    });
    expect(byRule(result, "ARCH008")).toEqual([]);
  });
});
