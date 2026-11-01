/**
 * BOLA on writes when the read is public (reported by sw-real7, wave 7, against examples/conduit-api).
 * Public GET + owner-only DELETE is the usual blog/Conduit pattern; the generator skipped the whole
 * resource because its read op was not secured, so "anyone can delete anyone's note" was missed.
 * The public GET itself must never be BOLA-checked (that would be a false positive).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runBugHunt } from "../../../src/engines/bugs/index.js";

const TOKENS: Record<string, string> = { "Bearer alice-token": "alice", "Bearer bob-token": "bob" };

const CONTRACT = {
  openapi: "3.0.3",
  info: { title: "notes", version: "1" },
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  paths: {
    "/notes": {
      post: {
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["text"],
                properties: { text: { type: "string", minLength: 1, maxLength: 20 } },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    note: {
                      type: "object",
                      properties: { slug: { type: "string" }, text: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "bad" },
          "401": { description: "no auth" },
        },
      },
    },
    "/notes/{slug}": {
      parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
      get: {
        responses: {
          "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } },
          "404": { description: "missing" },
        },
      },
      delete: {
        security: [{ bearer: [] }],
        responses: {
          "204": { description: "deleted" },
          "401": { description: "no auth" },
          "403": { description: "not owner" },
          "404": { description: "missing" },
        },
      },
    },
  },
};

function startNotes(checkOwner: boolean): Promise<{ url: string; close: () => Promise<void> }> {
  const notes = new Map<string, { owner: string; text: string }>();
  let n = 0;
  const server = http.createServer((req, res) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const user = TOKENS[req.headers.authorization ?? ""];
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/notes" && req.method === "POST") {
        if (!user) return send(401, { error: "auth" });
        let body: { text?: unknown };
        try {
          body = JSON.parse(raw);
        } catch {
          return send(400, { error: "json" });
        }
        if (typeof body?.text !== "string" || body.text.length < 1 || body.text.length > 20)
          return send(400, { error: "text" });
        const slug = `n${++n}`;
        notes.set(slug, { owner: user, text: body.text });
        return send(201, { note: { slug, text: body.text } });
      }
      const m = /^\/notes\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const note = notes.get(decodeURIComponent(m[1] as string));
        if (req.method === "GET") return note ? send(200, { note }) : send(404, { error: "missing" });
        if (req.method === "DELETE") {
          if (!user) return send(401, { error: "auth" });
          if (!note) return send(404, { error: "missing" });
          if (checkOwner && note.owner !== user) return send(403, { error: "not owner" });
          notes.delete(decodeURIComponent(m[1] as string));
          return send(204);
        }
      }
      send(404, { error: "route" });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

let app: { url: string; close: () => Promise<void> } | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function hunt(checkOwner: boolean) {
  app = await startNotes(checkOwner);
  return runBugHunt(
    {
      target: app.url,
      openapi: CONTRACT as unknown as Record<string, unknown>,
      seed: 3,
      allowMutations: true,
      techniques: ["auth"],
      auth: {
        roles: {
          alice: { type: "bearer", token: "alice-token" },
          bob: { type: "bearer", token: "bob-token" },
        },
      },
      stateful: {
        resources: [
          {
            name: "note",
            create: "POST /notes",
            read: "GET /notes/{slug}",
            delete: "DELETE /notes/{slug}",
            idPointer: "/note/slug",
            body: { text: "hello" },
          },
        ],
      },
    },
    { seed: 3 },
  );
}

describe("BOLA with a public read and an owner-only delete", () => {
  it("finds the missing ownership check on DELETE, and never flags the public GET", async () => {
    const r = await hunt(false);
    const bola = r.findings.filter((f) => f.ruleId === "bugs/bola");
    expect(
      bola.map((f) => f.title),
      JSON.stringify(r.findings.map((f) => [f.ruleId, f.title])),
    ).toEqual([expect.stringMatching(/DELETE \/notes\/\{slug\}/)]);
    expect(bola[0]?.classification).toBe("reproduced-defect");
  }, 60_000);

  it("reports nothing when the delete checks ownership (precision control)", async () => {
    const r = await hunt(true);
    expect(r.findings.filter((f) => f.ruleId === "bugs/bola")).toEqual([]);
  }, 60_000);
});
