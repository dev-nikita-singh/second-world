/**
 * The `sw ui` HTTP server (docs/09-cli-and-api.md §1 "sw ui"; API contract: .agents/PLAN-wave10.md).
 * node:http on 127.0.0.1 only. Static app files are public (no data in them); every /api route needs the
 * session token (src/ui/server/security.ts). Tests run as child `sw` processes (src/ui/server/jobs.ts).
 */
import { statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { maskConfig } from "../../core/config/loader.js";
import type { World } from "../../core/world.js";
import type { HistoryRun } from "../../engines/history/types.js";
import type { ApiError, JobRequest, SessionInfo } from "../shared/api-types.js";
import type { Assets } from "./assets.js";
import {
  compareRuns,
  findingsAcrossRuns,
  historyStore,
  NotFoundError,
  renderRun,
  runDetail,
  runsPage,
  targetsHealth,
  validRunId,
} from "./data.js";
import {
  buildCommand,
  buildReplayCommand,
  engineCatalogue,
  JobRequestError,
  type ScenarioRow,
} from "./engines.js";
import { JobBusyError, type JobRunner } from "./jobs.js";
import { hostAllowed, newToken, originAllowed, setSecurityHeaders, tokenOk } from "./security.js";

export const MAX_BODY = 64 * 1024;

export interface UiServerOptions {
  /** Loads (or reloads) the World for the project. */
  loadWorld(): Promise<World>;
  /** An already loaded World to start with (avoids loading the config twice). */
  initialWorld?: World;
  runner: JobRunner;
  assets: Assets;
  version: string;
  /** Global CLI flags every job repeats (e.g. ["--config", "/abs/sw.config.ts"]). */
  globals: string[];
  scenarios: ScenarioRow[];
  /** Doctor results (the same object as `sw doctor --json`). */
  doctor(): Promise<unknown>;
  /** 0 = any free port. */
  port: number;
  /** Fixed token (tests); default random. */
  token?: string;
}

export interface UiServer {
  readonly url: string;
  /** URL with the token in the fragment: what the user opens. */
  readonly openUrl: string;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Partial<ApiError["error"]> = {},
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, e: HttpError): void {
  sendJson(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } } satisfies ApiError);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "TOO_LARGE", "Request body too large");
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "BAD_JSON", "Body is not valid JSON");
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function startUiServer(o: UiServerOptions): Promise<UiServer> {
  const token = o.token ?? newToken();
  let world = o.initialWorld ?? (await o.loadWorld());
  let configStamp = stamp(world.config.configFile);
  const warnings: string[] = [...world.config.warnings];
  const runCache = new Map<string, HistoryRun>();

  function stamp(file: string | undefined): number {
    if (!file) return 0;
    try {
      return statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Picks up config edits made while the UI is open. */
  async function currentWorld(): Promise<World> {
    const s = stamp(world.config.configFile);
    if (s !== configStamp) {
      try {
        const next = await o.loadWorld();
        const old = world;
        world = next;
        configStamp = s;
        warnings.length = 0;
        warnings.push(...next.config.warnings);
        await old.close().catch(() => {});
      } catch (e) {
        configStamp = s;
        warnings.length = 0;
        warnings.push(`The config could not be reloaded (using the previous one): ${(e as Error).message}`);
      }
    }
    return world;
  }

  let port = 0;

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const path = url.pathname;
    const isEvents = /^\/api\/jobs\/[A-Za-z0-9-]+\/events$/.test(path);
    if (!tokenOk(req, url, token, isEvents))
      throw new HttpError(401, "UNAUTHORIZED", "Missing or wrong session token");
    if (method !== "GET" && method !== "HEAD" && !originAllowed(req.headers.origin, port))
      throw new HttpError(403, "BAD_ORIGIN", "Cross-origin request refused");
    const w = await currentWorld();

    if (method === "GET" && path === "/api/session") {
      const cfg = w.config.config;
      const body: SessionInfo = {
        version: o.version,
        project: {
          name: cfg.project?.name ?? basename(w.config.cwd),
          root: w.config.cwd,
          configPath: w.config.configFile ?? null,
        },
        engines: engineCatalogue(cfg, o.scenarios),
        history: { enabled: cfg.history.enabled, backend: cfg.history.backend, dir: cfg.history.dir },
        running: o.runner.running,
        warnings,
      };
      return sendJson(res, 200, body);
    }
    if (method === "GET" && path === "/api/targets")
      return sendJson(res, 200, { targets: await targetsHealth(w) });
    if (method === "GET" && path === "/api/runs") {
      const q = url.searchParams;
      const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
      return sendJson(
        res,
        200,
        await runsPage(await historyStore(w), {
          ...(q.get("engine") ? { engine: q.get("engine") as string } : {}),
          ...(q.get("status") ? { status: q.get("status") as string } : {}),
          ...(q.get("search") ? { search: q.get("search") as string } : {}),
          ...(q.get("before") ? { before: q.get("before") as string } : {}),
          ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
        }),
      );
    }
    if (method === "GET" && path === "/api/runs/diff") {
      const b = url.searchParams.get("baseline") ?? "";
      const c = url.searchParams.get("current") ?? "";
      if (!validRunId(b) || !validRunId(c))
        throw new HttpError(400, "BAD_REQUEST", "baseline and current must be run ids");
      return sendJson(res, 200, await compareRuns(w, await historyStore(w), b, c));
    }
    let m = /^\/api\/runs\/([^/]+)\/report\.([a-z]+)$/.exec(path);
    if (method === "GET" && m) {
      const r = await renderRun(w, await historyStore(w), m[1] as string, m[2] as string, o.version);
      res.writeHead(200, {
        "Content-Type": r.type,
        "Content-Disposition": `attachment; filename="${r.filename}"`,
        "Cache-Control": "no-store",
      });
      res.end(r.body);
      return;
    }
    m = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (method === "GET" && m)
      return sendJson(res, 200, await runDetail(w, await historyStore(w), m[1] as string, o.version));
    m = /^\/api\/runs\/([^/]+)\/replay$/.exec(path);
    if (method === "POST" && m) {
      if (!validRunId(m[1] as string)) throw new HttpError(404, "NOT_FOUND", "No such run");
      const body = (await readJson(req)) as { fingerprint?: unknown };
      if (typeof body.fingerprint !== "string")
        throw new HttpError(400, "BAD_REQUEST", "fingerprint is required");
      const built = buildReplayCommand(body.fingerprint, o.globals);
      return sendJson(res, 202, { job: o.runner.start("replay", built.args, built.display) });
    }
    if (method === "GET" && path === "/api/findings") {
      const scan = Number(url.searchParams.get("scan") ?? 50);
      return sendJson(
        res,
        200,
        await findingsAcrossRuns(
          await historyStore(w),
          Number.isFinite(scan) ? Math.min(Math.max(scan, 1), 500) : 50,
          runCache,
        ),
      );
    }
    if (method === "GET" && path === "/api/config")
      return sendJson(res, 200, { path: w.config.configFile ?? null, config: maskConfig(w.config.config) });
    if (method === "GET" && path === "/api/doctor") return sendJson(res, 200, await o.doctor());
    if (method === "GET" && path === "/api/jobs/current")
      return sendJson(res, 200, { job: o.runner.latest() });
    if (method === "POST" && path === "/api/jobs") {
      const body = (await readJson(req)) as JobRequest;
      if (!body || typeof body !== "object")
        throw new HttpError(400, "BAD_REQUEST", "Body must be an object");
      const built = buildCommand(body, w.config.config, o.scenarios, o.globals);
      return sendJson(res, 202, {
        job: o.runner.start(body.engine, built.args, built.display, body.dryRun === true),
      });
    }
    m = /^\/api\/jobs\/([A-Za-z0-9-]+)\/stop$/.exec(path);
    if (method === "POST" && m) {
      const job = o.runner.stop(m[1] as string);
      if (!job) throw new HttpError(404, "NOT_FOUND", "No such running test");
      return sendJson(res, 202, { job });
    }
    m = /^\/api\/jobs\/([A-Za-z0-9-]+)\/events$/.exec(path);
    if (method === "GET" && m) return events(res, req, m[1] as string);
    throw new HttpError(404, "NOT_FOUND", "No such API route");
  }

  function events(res: ServerResponse, req: IncomingMessage, id: string): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const sub = o.runner.subscribe(id, (ev) => {
      if (ev.type === "line") send("line", ev.line);
      else {
        send(ev.type, ev.job);
        if (ev.type === "end") {
          clearInterval(ping);
          res.end();
        }
      }
    });
    if (!sub) {
      send("error", { code: "NOT_FOUND", message: "No such test" });
      res.end();
      return;
    }
    if (sub.dropped > 0)
      send("line", { stream: "stderr", text: `… ${sub.dropped} earlier line(s) not kept` });
    for (const l of sub.lines) send("line", l);
    send("status", sub.job);
    // Keeps proxies and the browser from timing the stream out during quiet phases.
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    if (sub.job.state === "finished") {
      clearInterval(ping);
      send("end", sub.job);
      res.end();
      return;
    }
    req.on("close", () => {
      clearInterval(ping);
      sub.off();
    });
  }

  const server = createServer(async (req, res) => {
    setSecurityHeaders(res);
    try {
      if (!hostAllowed(req.headers.host, port))
        throw new HttpError(421, "BAD_HOST", "This server only answers on 127.0.0.1 / localhost");
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new HttpError(405, "METHOD", "Method not allowed");
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const f = o.assets.files.get(name);
      if (!f) throw new HttpError(404, "NOT_FOUND", "Not found");
      res.writeHead(200, {
        "Content-Type": f.type,
        "Content-Length": f.body.length,
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : f.body);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof HttpError) return sendError(res, e);
      if (e instanceof JobRequestError)
        return sendError(
          res,
          new HttpError(e.code === "CONFIRM_REQUIRED" ? 428 : 400, e.code, e.message, {
            ...(e.issues.length ? { issues: e.issues } : {}),
            ...(e.needs.length ? { needs: e.needs } : {}),
          }),
        );
      if (e instanceof JobBusyError) return sendError(res, new HttpError(409, "BUSY", e.message));
      if (e instanceof NotFoundError) return sendError(res, new HttpError(404, "NOT_FOUND", e.message));
      const msg = (e as Error).message ?? String(e);
      // Config / history problems are user-facing (e.g. a corrupt history file): say what failed.
      return sendError(res, new HttpError(500, "INTERNAL", msg));
    }
  });
  server.keepAliveTimeout = 5000;

  try {
    port = await listen(server, o.port);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || o.port === 0) throw e;
    port = await listen(server, 0);
  }

  const url = `http://127.0.0.1:${port}/`;
  return {
    url,
    openUrl: `${url}#t=${token}`,
    port,
    token,
    async close() {
      await o.runner.shutdown();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      await world.close().catch(() => {});
    },
  };
}
