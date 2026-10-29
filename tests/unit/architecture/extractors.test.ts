import { describe, expect, it } from "vitest";
import { byRule, inspectFiles } from "./helpers.js";

const routeIds = (d: { routes: { method: string; path: string }[] }) =>
  d.routes.map((r) => `${r.method} ${r.path}`).sort();

describe("framework extractors", () => {
  it("express: app/router verbs, params, router mounted with prefix, route() chains, middlewares", async () => {
    const { data } = await inspectFiles({
      "src/app.ts": `
import express from "express";
import { usersRouter } from "./users.js";
import { requireAuth } from "./auth.js";
const app = express();
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api", requireAuth, usersRouter);
app.route("/items/:itemId").get((req, res) => res.end()).post(requireAuth, (req, res) => res.end());
app.get("setting");
export default app;
`,
      "src/users.ts": `
import { Router } from "express";
export const usersRouter = Router();
usersRouter.get("/users/:id", async (req, res) => { res.json({}); });
usersRouter.delete("/users/:id", (req, res) => res.end());
`,
      "src/auth.ts": `export function requireAuth(req: any, res: any, next: any) { next(); }`,
    });
    expect(routeIds(data)).toEqual([
      "DELETE /api/users/:id",
      "GET /api/users/:id",
      "GET /health",
      "GET /items/:itemId",
      "POST /items/:itemId",
    ]);
    const del = data.routes.find((r) => r.path === "/api/users/:id" && r.method === "DELETE");
    expect(del?.auth).toBe(true); // inherited from app.use("/api", requireAuth, …)
    expect(
      data.routes.find((r) => r.method === "POST" && r.path === "/items/:itemId")?.middlewares,
    ).toContain("requireAuth");
    expect(data.routes.find((r) => r.path === "/health")?.auth).toBe(false);
    expect(data.project.frameworks).toEqual(["express"]);
    // route -> handler edges with evidence
    const e = data.edges.find((x) => x.from === "route:GET /health");
    expect(e?.kind).toBe("calls");
    expect(e?.evidence[0]).toMatchObject({ file: "src/app.ts", line: 7, extractor: "framework/express" });
  });

  it("express: router factory function mounted via app.use(factory())", async () => {
    const { data } = await inspectFiles({
      "src/server.ts": `
import express from "express";
import { productsRouter } from "./products.js";
const app = express();
app.use("/v1", productsRouter());
`,
      "src/products.ts": `
import { Router } from "express";
export function productsRouter() { const r = Router(); r.get("/products", (q, s) => s.end()); return r; }
`,
    });
    expect(routeIds(data)).toEqual(["GET /v1/products"]);
  });

  it("fastify: verbs with options, route({...}), register with prefix, preHandler auth", async () => {
    const { data } = await inspectFiles({
      "src/server.ts": `
import Fastify from "fastify";
import routes from "./routes.js";
const app = Fastify();
app.get("/healthz", async () => ({ ok: true }));
app.post("/login", { schema: {} }, async (req) => ({}));
app.route({ method: ["GET", "HEAD"], url: "/things/:id", preHandler: [verifyJwt], handler: async () => ({}) });
app.register(routes, { prefix: "/v2" });
function verifyJwt() {}
`,
      "src/routes.ts": `
import type { FastifyInstance } from "fastify";
export default async function routes(fastify: FastifyInstance) {
  fastify.get("/orders", async () => []);
}
`,
    });
    expect(routeIds(data)).toEqual([
      "GET /healthz",
      "GET /things/:id",
      "GET /v2/orders",
      "HEAD /things/:id",
      "POST /login",
    ]);
    expect(data.routes.find((r) => r.path === "/things/:id")?.auth).toBe(true);
    expect(data.project.frameworks).toEqual(["fastify"]);
  });

  it("hono and koa (@koa/router with prefix)", async () => {
    const { data } = await inspectFiles({
      "src/hono.ts": `
import { Hono } from "hono";
const app = new Hono();
const api = new Hono();
api.get("/books/:id", (c) => c.json({}));
app.route("/api", api);
app.post("/echo", (c) => c.text("x"));
`,
      "src/koa.ts": `
import Router from "@koa/router";
const router = new Router({ prefix: "/k" });
router.get("/users", async (ctx) => {});
`,
    });
    expect(routeIds(data)).toEqual(["GET /api/books/:id", "GET /k/users", "POST /echo"]);
    expect(data.project.frameworks).toEqual(["hono", "koa"]);
  });

  it("nest: @Controller + verb decorators, guards and @Public", async () => {
    const { data } = await inspectFiles({
      "src/users.controller.ts": `
import { Controller, Get, Post, UseGuards } from "@nestjs/common";
const Public = () => () => {};
class AuthGuard {}
@UseGuards(AuthGuard)
@Controller("users")
export class UsersController {
  constructor(private readonly svc: UsersService) {}
  @Get(":id") find() { return this.svc.find(); }
  @Post() create() { return 1; }
  @Public() @Get("public/info") info() { return 1; }
}
export class UsersService { find() { return 1; } }
`,
    });
    expect(routeIds(data)).toEqual(["GET /users/:id", "GET /users/public/info", "POST /users"]);
    expect(data.routes.every((r) => r.auth)).toBe(true);
    // DI call resolved through the constructor parameter type
    expect(
      data.edges.some(
        (e) =>
          e.from === "fn:src/users.controller.ts#UsersController.find" &&
          e.to === "fn:src/users.controller.ts#UsersService.find",
      ),
    ).toBe(true);
  });

  it("next.js app router route handlers and pages/api", async () => {
    const { data } = await inspectFiles({
      "app/api/users/[id]/route.ts": `export async function GET(req: Request) { return new Response("x"); }\nexport const POST = async () => new Response("y");`,
      "pages/api/ping.ts": `export default function handler(req: any, res: any) { res.end(); }`,
    });
    expect(routeIds(data)).toEqual(["ALL /api/ping", "GET /api/users/:id", "POST /api/users/:id"]);
  });

  it("frameworks option disables other framework extractors", async () => {
    const { data } = await inspectFiles(
      { "a.ts": `import express from "express"; const app = express(); app.get("/x", (q, s) => s.end());` },
      { frameworks: ["fastify"] },
    );
    expect(data.routes).toHaveLength(0);
  });
});

describe("client extractors", () => {
  it("http clients: fetch / axios / got / undici with timeout detection", async () => {
    const { result, data } = await inspectFiles({
      "src/c.ts": `
import axios from "axios";
import got from "got";
import { request } from "undici";
const api = axios.create({ baseURL: "https://api.example.com", timeout: 2000 });
export async function a() {
  await fetch("https://pay.example.com/charge");                                   // no timeout
  await fetch("https://pay.example.com/charge", { signal: AbortSignal.timeout(1000) });
  await axios.get("https://b.example.com/x");                                        // no timeout
  await axios.get("https://b.example.com/x", { timeout: 100 });
  await api.get("/y");
  await got("https://c.example.com");                                                // no timeout
  await got.post("https://c.example.com", { timeout: { request: 100 } });
  await request("https://d.example.com");                                            // no timeout (undici defaults)
}
`,
    });
    const ext = data.components
      .filter((c) => c.kind === "external")
      .map((c) => c.id)
      .sort();
    expect(ext).toEqual([
      "external:b.example.com",
      "external:c",
      "external:c.example.com",
      "external:d.example.com",
      "external:pay.example.com",
    ]);
    const lines = byRule(result, "ARCH001")
      .map((f) => f.locations[0]?.line)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(lines).toEqual([7, 9, 12, 14]);
    const undici = byRule(result, "ARCH001").find((f) => f.locations[0]?.line === 14);
    expect(undici?.confidence).toBe(0.5);
  });

  it("axios.defaults.timeout suppresses ARCH001 for axios", async () => {
    const { result } = await inspectFiles({
      "src/c.ts": `import axios from "axios"; axios.defaults.timeout = 1000; export const f = () => axios.get("https://x.io");`,
    });
    expect(byRule(result, "ARCH001")).toHaveLength(0);
  });

  it("db clients: pg, mysql2, prisma, typeorm, drizzle, mongoose, knex with reads/writes", async () => {
    const { data } = await inspectFiles({
      "src/db.ts": `
import { Pool } from "pg";
import mysql from "mysql2/promise";
import { PrismaClient } from "@prisma/client";
import { DataSource } from "typeorm";
import { drizzle } from "drizzle-orm/node-postgres";
import mongoose from "mongoose";
import knexFactory from "knex";
export const pool = new Pool({ max: 10 });
const my = mysql.createPool({ connectionLimit: 5 });
const prisma = new PrismaClient();
const ds = new DataSource({});
const db = drizzle(pool);
const User = mongoose.model("User", {});
const knex = knexFactory({ client: "pg", pool: { max: 5 } });
export async function all() {
  await pool.query("SELECT 1");
  await pool.query("INSERT INTO t VALUES (1)");
  await my.query("UPDATE t SET a = 1");
  await prisma.user.findMany();
  await prisma.user.create({ data: {} });
  await ds.getRepository("User").save({});
  await db.select();
  await User.find({});
  await knex("users").where({ id: 1 }).update({ a: 1 });
}
`,
    });
    const stores = data.components
      .filter((c) => c.kind === "datastore")
      .map((c) => c.id)
      .sort();
    expect(stores).toEqual([
      "datastore:drizzle",
      "datastore:knex",
      "datastore:mongodb",
      "datastore:mysql",
      "datastore:postgres",
      "datastore:prisma",
      "datastore:typeorm",
    ]);
    const kinds = (to: string) =>
      data.edges
        .filter((e) => e.to === to)
        .map((e) => e.kind)
        .sort();
    expect(kinds("datastore:postgres")).toEqual(["reads", "writes"]);
    expect(kinds("datastore:mysql")).toEqual(["writes"]);
    expect(kinds("datastore:prisma")).toEqual(["reads", "writes"]);
    expect(kinds("datastore:typeorm")).toEqual(["writes"]);
    expect(kinds("datastore:knex")).toEqual(["writes"]);
    const ev = data.edges.find((e) => e.to === "datastore:postgres")?.evidence[0];
    expect(ev).toMatchObject({ file: "src/db.ts", extractor: "clients/db" });
    expect(ev?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("project repository classes are datastores by naming heuristic (confidence < 0.6)", async () => {
    const { data } = await inspectFiles({
      "src/repo.ts": `export class UserRepository { async findById(id: string) { return id; } async save(u: unknown) { return u; } }`,
      "src/svc.ts": `import { UserRepository } from "./repo.js"; const repo = new UserRepository(); export async function f() { await repo.findById("1"); await repo.save({}); }`,
    });
    const n = data.components.find((c) => c.id === "datastore:UserRepository");
    expect(n?.heuristic).toBe(true);
    const e = data.edges.filter((x) => x.to === "datastore:UserRepository");
    expect(e.map((x) => x.kind).sort()).toEqual(["reads", "writes"]);
    expect(e[0]?.evidence[0]?.confidence).toBeLessThan(0.6);
    expect(e[0]?.evidence[0]?.heuristic).toBe(true);
  });

  it("caches and queues: ioredis, redis, bullmq, amqplib, kafkajs, sqs", async () => {
    const { data } = await inspectFiles({
      "src/q.ts": `
import Redis from "ioredis";
import { createClient } from "redis";
import { Queue, Worker } from "bullmq";
import amqp from "amqplib";
import { Kafka } from "kafkajs";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
const redis = new Redis();
const rc = createClient();
const emails = new Queue("emails");
const kafka = new Kafka({ brokers: [] });
const producer = kafka.producer();
const sqs = new SQSClient({});
export async function go() {
  await redis.get("k");
  await rc.set("k", "v");
  await emails.add("welcome", {});
  const conn = await amqp.connect("amqp://localhost");
  const ch = await conn.createChannel();
  ch.sendToQueue("jobs", Buffer.from("x"));
  await ch.consume("jobs", (m) => {});
  await producer.send({ topic: "orders", messages: [] });
  await sqs.send(new SendMessageCommand({ QueueUrl: "https://sqs.local/123/invoices", MessageBody: "x" }));
}
new Worker("emails", async (job) => { await redis.set("sent", "1"); });
`,
    });
    const ids = data.components
      .filter((c) => c.kind === "cache" || c.kind === "queue")
      .map((c) => c.id)
      .sort();
    expect(ids).toEqual(["cache:redis", "queue:emails", "queue:invoices", "queue:jobs", "queue:orders"]);
    const consumer = data.components.find((c) => c.name === "worker:emails");
    expect(consumer?.kind).toBe("handler");
    expect(
      data.edges.some((e) => e.from === consumer?.id && e.to === "queue:emails" && e.kind === "consumes"),
    ).toBe(true);
    expect(
      data.edges.some((e) => e.from === consumer?.id && e.to === "cache:redis" && e.kind === "writes"),
    ).toBe(true);
  });
});

describe("imports", () => {
  it("module edges for static/require/re-export; type-only and computed dynamic imports handled", async () => {
    const { data, result } = await inspectFiles({
      "src/a.ts": `import { b } from "./b.js"; import type { T } from "./t.js"; export * from "./c.js"; const x = require("./d.js"); const m = "./e.js"; export const lazy = () => import(m); export const y: T = b;`,
      "src/b.ts": `export const b = 1;`,
      "src/c.ts": `export const c = 1;`,
      "src/d.ts": `export const d = 1;`,
      "src/t.ts": `export type T = number;`,
    });
    const targets = data.edges
      .filter((e) => e.from === "module:src/a.ts" && e.kind === "imports")
      .map((e) => e.to)
      .sort();
    expect(targets).toEqual(["module:src/b.ts", "module:src/c.ts", "module:src/d.ts", "module:src/t.ts"]);
    expect(result.limitations.some((l) => l.code === "ARCH_DYNAMIC_IMPORT")).toBe(true);
  });
});
