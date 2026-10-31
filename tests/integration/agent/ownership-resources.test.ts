/**
 * Agent ownership/lifecycle on a blog-like API (wave 7b, sw-agent8):
 * - responses are wrapped (`{ article: { slug } }`) and items are addressed by slug, so the agent
 *   needs the configured `resources` (idPointer "/article/slug") to bind `{{rid}}`;
 * - the item read is public, DELETE is owner-only: a cross-account READ is not a violation
 *   (no finding), a cross-account DELETE that succeeds is (bugs/bola on DELETE only).
 * docs/03-engines/adversarial-test-agent.md §1 (ownership, lifecycle), §6 (resources).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/core/config/loader.js";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { buildAgentInput } from "../../../src/core/world.js";
import { type AgentData, runAgent } from "../../../src/engines/agent/index.js";

interface Blog {
  url: string;
  close(): Promise<void>;
}

const TOKENS: Record<string, string> = { "alice-token": "alice", "bob-token": "bob" };

async function startBlog(checkOwner: boolean): Promise<Blog> {
  const articles = new Map<string, { slug: string; title: string; author: string }>();
  let n = 0;
  const send = (res: ServerResponse, status: number, body?: unknown): void => {
    res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const user = (req: IncomingMessage): string | undefined =>
    TOKENS[(req.headers.authorization ?? "").replace(/^Bearer /, "")];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString("utf8");
    });
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/__test/reset" && req.method === "POST") {
        articles.clear();
        return send(res, 204);
      }
      if (u.pathname === "/articles" && req.method === "POST") {
        const who = user(req);
        if (!who) return send(res, 401, { error: "unauthorized" });
        let title = "untitled";
        try {
          const b = JSON.parse(raw) as { article?: { title?: unknown } };
          if (typeof b.article?.title === "string") title = b.article.title;
        } catch {
          return send(res, 400, { error: "bad json" });
        }
        const slug = `post-${++n}`;
        const a = { slug, title, author: who };
        articles.set(slug, a);
        return send(res, 201, { article: a });
      }
      const m = /^\/articles\/([^/]+)$/.exec(u.pathname);
      if (m) {
        const a = articles.get(decodeURIComponent(m[1] as string));
        if (req.method === "GET") return a ? send(res, 200, { article: a }) : send(res, 404, { error: "nf" });
        if (req.method === "DELETE") {
          const who = user(req);
          if (!who) return send(res, 401, { error: "unauthorized" });
          if (!a) return send(res, 404, { error: "nf" });
          if (checkOwner && a.author !== who) return send(res, 403, { error: "forbidden" });
          articles.delete(a.slug);
          return send(res, 204);
        }
      }
      send(res, 404, { error: "no route" });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

const article = {
  type: "object",
  required: ["article"],
  properties: {
    article: {
      type: "object",
      required: ["slug", "title", "author"],
      properties: { slug: { type: "string" }, title: { type: "string" }, author: { type: "string" } },
    },
  },
};
const err = { description: "error", content: { "application/json": { schema: { type: "object" } } } };
const OPENAPI = {
  openapi: "3.0.3",
  info: { title: "blog", version: "1" },
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  paths: {
    "/articles": {
      post: {
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["article"],
                properties: {
                  article: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "created", content: { "application/json": { schema: article } } },
          "401": err,
        },
      },
    },
    "/articles/{slug}": {
      parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
      get: {
        responses: {
          "200": { description: "ok", content: { "application/json": { schema: article } } },
          "404": err,
        },
      },
      delete: {
        security: [{ bearer: [] }],
        responses: { "204": { description: "deleted" }, "401": err, "403": err, "404": err },
      },
    },
  },
};

const RESOURCES = [
  {
    name: "article",
    create: "POST /articles",
    read: "GET /articles/{slug}",
    delete: "DELETE /articles/{slug}",
    idPointer: "/article/slug",
    body: { article: { title: "sw probe" } },
  },
];

async function agentRun(blog: Blog, withResources: boolean): Promise<EngineResult<AgentData>> {
  return runAgent(
    {
      target: blog.url,
      openapi: OPENAPI,
      seed: 7,
      allowMutations: true,
      allowDestructive: true,
      auth: {
        roles: {
          alice: { type: "bearer", token: "alice-token" },
          bob: { type: "bearer", token: "bob-token" },
        },
      },
      hooks: { reset: { http: { method: "POST", url: `${blog.url}/__test/reset` } } },
      techniques: ["ownership", "lifecycle"],
      ...(withResources ? { resources: RESOURCES } : {}),
      budget: { maxIterations: 30, maxRequests: 300, patience: 15 },
    },
    { seed: 7 },
  );
}

const bola = (r: EngineResult<AgentData>) =>
  r.findings.filter((f) => f.ruleId === "bugs/bola" && f.classification === "reproduced-defect");

describe("agent: configured resources on a wrapped, slug-addressed API", () => {
  let open: Blog;
  let checked: Blog;
  beforeAll(async () => {
    open = await startBlog(false);
    checked = await startBlog(true);
  });
  afterAll(async () => {
    await open?.close();
    await checked?.close();
  });

  it("with resources: lifecycle binds {{rid}} from /article/slug (no unresolved variables)", async () => {
    const r = await agentRun(checked, true);
    const d = r.data as AgentData;
    const life = d.hypotheses.filter((h) => h.technique === "lifecycle");
    expect(life.length).toBeGreaterThan(0);
    for (const h of d.hypotheses) expect(h.reason ?? "", h.title).not.toMatch(/unresolved variables/);
    expect(life.some((h) => h.outcome === "passed")).toBe(true);
  }, 60_000);

  it("public read + owner-only DELETE without the check: bugs/bola on DELETE only", async () => {
    const r = await agentRun(open, true);
    const ops = [...new Set(bola(r).map((f) => f.affected[0]))];
    expect(ops).toEqual(["DELETE /articles/{slug}"]);
    expect(r.findings.filter((f) => f.affected[0] === "GET /articles/{slug}")).toEqual([]);
  }, 60_000);

  it("public read + owner-only DELETE with the check: no ownership finding", async () => {
    const r = await agentRun(checked, true);
    expect(r.findings).toEqual([]);
  }, 60_000);
});

describe("agent: resources through the config/world path (bugs.stateful.resources only)", () => {
  let open: Blog;
  beforeAll(async () => {
    open = await startBlog(false);
  });
  afterAll(async () => {
    await open?.close();
  });

  it("buildAgentInput forwards bugs.stateful.resources: bola on DELETE, no unresolved {{rid}}", async () => {
    const cfg = await loadConfig({
      env: {},
      userConfig: false,
      inline: {
        targets: { api: { url: open.url } },
        auth: {
          alice: { type: "bearer", token: "alice-token" },
          bob: { type: "bearer", token: "bob-token" },
        },
        hooks: { reset: { http: { method: "POST", url: `${open.url}/__test/reset` } } },
        bugs: { contract: OPENAPI, stateful: { resources: RESOURCES } },
        agent: {
          allowMutations: true,
          allowDestructive: true,
          techniques: ["ownership", "lifecycle"],
          budget: { maxIterations: 30, maxRequests: 300, patience: 15 },
        },
      },
    });
    const input = buildAgentInput(cfg, {}, { seed: 7, env: {} });
    expect(input.resources).toEqual(RESOURCES);
    const r = await runAgent(input as Parameters<typeof runAgent>[0], { seed: 7 });
    const d = r.data as AgentData;
    for (const h of d.hypotheses) expect(h.reason ?? "", h.title).not.toMatch(/unresolved variables/);
    expect([...new Set(bola(r).map((f) => f.affected[0]))]).toEqual(["DELETE /articles/{slug}"]);
  }, 60_000);
});
