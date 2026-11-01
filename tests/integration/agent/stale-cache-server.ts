/**
 * In-test "notes" API with a read cache (sw-gaps-w8, gaps 3 and 4). GET /notes/{id} fills a cache;
 * with `staleCache: true` PUT updates the store but forgets to invalidate the cache, so a read after
 * an update returns the old note (the stale read sw-real2-w8 planted in orders-jobs-api).
 * Shared by the agent and Bug Hunter tests; no defect other than the stale read.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface NotesServer {
  url: string;
  /** Requests per "METHOD /route" (test control excluded). */
  counts: Map<string, number>;
  /** Method sequence of every note ever created (kept across resets), e.g. ["POST", "GET", "PUT", "GET"]. */
  sequences: string[][];
  close(): Promise<void>;
}

interface Note {
  id: number;
  owner: string;
  title: string;
  text: string;
}

const TOKENS: Record<string, string> = { "alice-token": "alice", "bob-token": "bob" };

export async function startNotesServer(opts: { staleCache: boolean }): Promise<NotesServer> {
  const store = new Map<number, Note>();
  const cache = new Map<number, Note>();
  const counts = new Map<string, number>();
  const history = new Map<number, string[]>();
  const sequences: string[][] = [];
  let next = 1;
  const send = (res: ServerResponse, status: number, body?: unknown): void => {
    res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const user = (req: IncomingMessage): string | undefined =>
    TOKENS[(req.headers.authorization ?? "").replace(/^Bearer /, "")];
  const valid = (b: unknown): b is { title: string; text: string } => {
    if (typeof b !== "object" || b === null) return false;
    const o = b as Record<string, unknown>;
    return (
      typeof o.title === "string" &&
      o.title.length >= 1 &&
      o.title.length <= 80 &&
      typeof o.text === "string" &&
      o.text.length <= 500
    );
  };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString("utf8");
    });
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/__test/reset" && req.method === "POST") {
        store.clear();
        cache.clear();
        history.clear();
        next = 1;
        return send(res, 204);
      }
      const item = /^\/notes\/([^/]+)$/.exec(u.pathname);
      const route = `${req.method} ${item ? "/notes/{id}" : u.pathname}`;
      counts.set(route, (counts.get(route) ?? 0) + 1);
      const who = user(req);
      if (u.pathname.startsWith("/notes") && !who) return send(res, 401, { error: "unauthorized" });
      let body: unknown;
      if (raw !== "") {
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: "bad json" });
        }
      }
      if (u.pathname === "/notes" && req.method === "POST") {
        if (!valid(body)) return send(res, 400, { error: "invalid" });
        const n: Note = { id: next++, owner: who as string, title: body.title, text: body.text };
        store.set(n.id, n);
        const seq = ["POST"];
        history.set(n.id, seq);
        sequences.push(seq);
        return send(res, 201, n);
      }
      if (u.pathname === "/notes" && req.method === "GET") {
        return send(res, 200, { notes: [...store.values()].filter((n) => n.owner === who) });
      }
      if (item) {
        const id = Number(item[1]);
        if (!Number.isInteger(id) || id < 1) return send(res, 400, { error: "bad id" });
        const n = store.get(id);
        if (!n || n.owner !== who) return send(res, 404, { error: "not found" });
        history.get(id)?.push(req.method ?? "");
        if (req.method === "GET") {
          let c = cache.get(id);
          if (!c) {
            c = { ...n };
            cache.set(id, c);
          }
          return send(res, 200, c);
        }
        if (req.method === "PUT") {
          if (!valid(body)) return send(res, 400, { error: "invalid" });
          n.title = body.title;
          n.text = body.text;
          if (!opts.staleCache) cache.delete(id);
          return send(res, 200, n);
        }
        if (req.method === "DELETE") {
          store.delete(id);
          cache.delete(id);
          return send(res, 204);
        }
      }
      send(res, 404, { error: "no route" });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    counts,
    sequences,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

const note = {
  type: "object",
  required: ["id", "owner", "title", "text"],
  properties: {
    id: { type: "integer", minimum: 1 },
    owner: { type: "string" },
    title: { type: "string" },
    text: { type: "string" },
  },
};
const noteInput = {
  type: "object",
  required: ["title", "text"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 80 },
    text: { type: "string", maxLength: 500 },
  },
};
const err = { description: "error", content: { "application/json": { schema: { type: "object" } } } };
const json = (schema: unknown) => ({ "application/json": { schema } });

export const NOTES_OPENAPI = {
  openapi: "3.0.3",
  info: { title: "notes", version: "1" },
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  security: [{ bearer: [] }],
  paths: {
    "/notes": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: json({
              type: "object",
              required: ["notes"],
              properties: { notes: { type: "array", items: note } },
            }),
          },
          "401": err,
        },
      },
      post: {
        requestBody: { required: true, content: json(noteInput) },
        responses: { "201": { description: "created", content: json(note) }, "400": err, "401": err },
      },
    },
    "/notes/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
      get: {
        responses: { "200": { description: "ok", content: json(note) }, "400": err, "401": err, "404": err },
      },
      put: {
        requestBody: { required: true, content: json(noteInput) },
        responses: {
          "200": { description: "updated", content: json(note) },
          "400": err,
          "401": err,
          "404": err,
        },
      },
      delete: { responses: { "204": { description: "deleted" }, "400": err, "401": err, "404": err } },
    },
  },
};

export const NOTES_RESOURCES = [
  {
    name: "note",
    create: "POST /notes",
    read: "GET /notes/{id}",
    update: "PUT /notes/{id}",
    delete: "DELETE /notes/{id}",
    idPointer: "/id",
    body: { title: "sw probe", text: "probe text" },
  },
];

export const NOTES_ROLES = {
  alice: { type: "bearer" as const, token: "alice-token" },
  bob: { type: "bearer" as const, token: "bob-token" },
};
