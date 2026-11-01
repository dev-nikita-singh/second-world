/**
 * Honest coverage gaps and node:sqlite recognition (docs/03-engines/architecture-inspector.md §1.3, §5).
 * Found on examples/conduit-api (node:http dispatch + node:sqlite): `sw inspect` built a model of 26
 * nodes / 1 edge and said nothing about routes or the database being invisible to it.
 */
import { describe, expect, it } from "vitest";
import { inspectFiles } from "./helpers.js";

const NODE_HTTP_SERVER = `
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { listArticles } from "./articles.js";
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
// Keys built at run time: not one of the hand-written dispatch patterns inspect recognises.
const routes: Record<string, Handler> = {};
function on(key: string, h: Handler) { routes[key] = h; }
on(["GET", "/api/articles"].join(" "), async (_req, res) => { res.end(JSON.stringify(await listArticles())); });
export const server = createServer((req, res) => {
  const h = routes[\`\${req.method} \${req.url}\`];
  if (h) void h(req, res); else { res.statusCode = 404; res.end(); }
});
`;

const SQLITE_FIELD = `
import { DatabaseSync, type StatementSync } from "node:sqlite";
export class Store {
  private readonly sql: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  constructor() {
    this.sql = new DatabaseSync(":memory:");
    this.sql.exec("CREATE TABLE articles (id INTEGER PRIMARY KEY, title TEXT)");
  }
  stmt(q: string): StatementSync {
    let s = this.cache.get(q);
    if (!s) { s = this.sql.prepare(q); this.cache.set(q, s); }
    return s;
  }
}
`;

const ARTICLES = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
export async function listArticles() {
  return db.prepare("SELECT id, title FROM articles").all();
}
export function addArticle(title: string) {
  db.prepare("INSERT INTO articles (title) VALUES (?)").run(title);
}
`;

function codes(r: { limitations: { code: string }[] }): string[] {
  return r.limitations.map((l) => l.code);
}

describe("inspect: node:http / node:sqlite projects", () => {
  it("node:sqlite DatabaseSync .prepare/.exec are DB access (const and constructor-assigned field)", async () => {
    const { data, result } = await inspectFiles({
      "src/server.ts": NODE_HTTP_SERVER,
      "src/articles.ts": ARTICLES,
      "src/store.ts": SQLITE_FIELD,
    });
    const stores = data.components.filter((c) => c.kind === "datastore").map((c) => c.id);
    expect(stores).toEqual(["datastore:sqlite"]);
    const kinds = data.edges
      .filter((e) => e.to === "datastore:sqlite")
      .map((e) => e.kind)
      .sort();
    expect(kinds).toEqual(expect.arrayContaining(["reads", "writes"]));
    const files = new Set(
      data.edges.filter((e) => e.to === "datastore:sqlite").flatMap((e) => e.evidence.map((v) => v.file)),
    );
    expect([...files].sort()).toEqual(["src/articles.ts", "src/store.ts"]);
    expect(codes(result)).not.toContain("ARCH_NO_DB_ACCESS");
  });

  it("no recognised routes → ARCH_NO_ROUTES (reduces-confidence), naming node:http and the supported frameworks", async () => {
    const { result } = await inspectFiles({ "src/server.ts": NODE_HTTP_SERVER, "src/articles.ts": ARTICLES });
    const l = result.limitations.find((x) => x.code === "ARCH_NO_ROUTES");
    expect(l?.impact).toBe("reduces-confidence");
    expect(l?.message).toMatch(/node:http/);
    expect(l?.message).toMatch(/Express, Fastify, Hono, Koa/);
  });

  it("no recognised DB access → ARCH_NO_DB_ACCESS listing the supported drivers", async () => {
    const { result } = await inspectFiles({
      "src/server.ts": NODE_HTTP_SERVER,
      "src/articles.ts": `export async function listArticles() { return []; }`,
    });
    const l = result.limitations.find((x) => x.code === "ARCH_NO_DB_ACCESS");
    expect(l?.impact).toBe("reduces-confidence");
    expect(l?.message).toMatch(/pg, mysql2, Prisma/);
    expect(l?.message).toMatch(/node:sqlite/);
  });

  it("a recognised framework with DB access gets neither gap limitation", async () => {
    const { result, data } = await inspectFiles({
      "src/app.ts": `
import express from "express";
import { Pool } from "pg";
const pool = new Pool({ max: 5 });
export const app = express();
app.get("/items", async (_req, res) => { res.json((await pool.query("SELECT 1")).rows); });
`,
    });
    expect(data.routes.length).toBeGreaterThan(0);
    expect(codes(result)).not.toContain("ARCH_NO_ROUTES");
    expect(codes(result)).not.toContain("ARCH_NO_DB_ACCESS");
  });

  it("a DatabaseSync-typed field without a node:sqlite import is not DB access", async () => {
    const { data } = await inspectFiles({
      "src/x.ts": `
interface DatabaseSync { prepare(q: string): unknown }
export class Thing { constructor(private readonly sql: DatabaseSync) {} run() { return this.sql.prepare("x"); } }
`,
    });
    expect(data.components.filter((c) => c.kind === "datastore")).toEqual([]);
  });
});
