/**
 * Tiny inline API with deliberate, documented bugs for Bug Hunter integration tests:
 *  - DELETE /items/{id} answers 204 but does not delete (state-model bug)
 *  - POST /counter/inc has a read-await-write lost update (race)
 *  - GET /boom always 500 (discovery observation)
 * Everything else follows CONTRACT (OpenAPI 3.0, with `nullable`), incl. documented 404s.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const CONTRACT = {
  openapi: "3.0.3",
  info: { title: "mini", version: "1" },
  paths: {
    "/items": {
      get: {
        responses: {
          "200": {
            description: "list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items"],
                  properties: { items: { type: "array", items: { $ref: "#/components/schemas/Item" } } },
                },
              },
            },
          },
        },
      },
      post: {
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/NewItem" } } },
        },
        responses: {
          "201": {
            description: "created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } },
          },
          "400": { description: "invalid" },
        },
      },
    },
    "/items/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
      get: {
        responses: {
          "200": {
            description: "item",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } },
          },
          "400": { description: "bad id" },
          "404": { description: "not found" },
        },
      },
      delete: { responses: { "204": { description: "deleted" }, "404": { description: "not found" } } },
    },
    "/counter/inc": {
      post: {
        responses: {
          "200": {
            description: "new value",
            content: {
              "application/json": {
                schema: { type: "object", required: ["value"], properties: { value: { type: "integer" } } },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      NewItem: {
        type: "object",
        required: ["name", "price"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 20 },
          price: { type: "integer", minimum: 0, maximum: 1000 },
          note: { type: "string", nullable: true },
        },
      },
      Item: {
        allOf: [
          { $ref: "#/components/schemas/NewItem" },
          {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "integer", minimum: 1 },
              parent: { $ref: "#/components/schemas/Item" },
            },
          },
        ],
      },
    },
  },
} as const;

export interface MiniApi {
  url: string;
  close(): Promise<void>;
  methods: Record<string, number>;
  counter(): number;
}

export async function startMiniApi(): Promise<MiniApi> {
  let items = new Map<number, { id: number; name: string; price: number; note: string | null }>();
  let nextId = 1;
  let counter = 0;
  const methods: Record<string, number> = {};
  const send = (res: ServerResponse, status: number, body?: unknown): void => {
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };
  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    methods[method] = (methods[method] ?? 0) + 1;
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    try {
      if (p === "/__reset" && method === "POST") {
        items = new Map();
        nextId = 1;
        counter = 0;
        return send(res, 200, { ok: true });
      }
      if (p === "/boom") return send(res, 500, { error: "boom" });
      if (p === "/" && method === "GET") return send(res, 200, { name: "mini", links: ["/items"] });
      if (p === "/items" && method === "GET") return send(res, 200, { items: [...items.values()] });
      if (p === "/items" && method === "POST") {
        let b: unknown;
        try {
          b = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { error: "json" });
        }
        const o = b as { name?: unknown; price?: unknown; note?: unknown };
        if (
          typeof o !== "object" ||
          o === null ||
          typeof o.name !== "string" ||
          o.name.length < 1 ||
          o.name.length > 20 ||
          !Number.isInteger(o.price) ||
          (o.price as number) < 0 ||
          (o.price as number) > 1000 ||
          (o.note !== undefined && o.note !== null && typeof o.note !== "string")
        ) {
          return send(res, 400, { error: "invalid" });
        }
        const it = {
          id: nextId++,
          name: o.name,
          price: o.price as number,
          note: (o.note as string | null | undefined) ?? null,
        };
        items.set(it.id, it);
        return send(res, 201, it);
      }
      const m = /^\/items\/([^/]+)$/.exec(p);
      if (m) {
        const id = Number(m[1]);
        if (!Number.isInteger(id) || id < 1) return send(res, 400, { error: "bad id" });
        const it = items.get(id);
        if (method === "GET") return it ? send(res, 200, it) : send(res, 404, { error: "not found" });
        if (method === "DELETE") return it ? send(res, 204) : send(res, 404, { error: "not found" }); // BUG: never deletes
      }
      if (p === "/counter/inc" && method === "POST") {
        const v = counter; // BUG: read-await-write lost update
        await new Promise((r) => setTimeout(r, 5));
        counter = v + 1;
        return send(res, 200, { value: counter });
      }
      return send(res, 404, { error: "no route" });
    } catch {
      return send(res, 500, { error: "internal" });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    methods,
    counter: () => counter,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
