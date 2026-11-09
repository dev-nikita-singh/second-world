/**
 * `sw ui` server end to end (src/ui/server; docs/09 §1 "sw ui", docs/11 "Local UI server"): a real server on
 * 127.0.0.1:0, a small project in a temp dir, and real `sw` child processes for the jobs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorld } from "../../../src/core/world.js";
import { listScenarios } from "../../../src/engines/reliability/scenarios.js";
import { loadAssets } from "../../../src/ui/server/assets.js";
import { JobRunner } from "../../../src/ui/server/jobs.js";
import { startUiServer, type UiServer } from "../../../src/ui/server/server.js";
import type { RunDetail, RunJob, RunsPage, SessionInfo } from "../../../src/ui/shared/api-types.js";
import { CLI_ENTRY, REPO_ROOT } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;

let tmp: TmpDir;
let userCfg: TmpDir;
let target: Server;
let ui: UiServer;
let cfgPath: string;

async function api<T = unknown>(
  p: string,
  init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: T; headers: Headers }> {
  const res = await fetch(`${ui.url.replace(/\/$/, "")}${p}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.token === null ? {} : { Authorization: `Bearer ${init.token ?? ui.token}` }),
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json: json as T, headers: res.headers };
}

/** Reads the job's SSE stream until `event: end`; returns the raw text. */
async function waitForEnd(jobId: string, timeoutMs = 120_000): Promise<{ text: string; job: RunJob }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(`${ui.url}api/jobs/${jobId}/events?t=${ui.token}`, { signal: ac.signal });
  expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (/event: end\ndata: .*\n\n/.test(text)) break;
    }
  } finally {
    clearTimeout(t);
    ac.abort();
  }
  const m = /event: end\ndata: (.*)\n/.exec(text);
  if (!m?.[1]) throw new Error(`no end event in:\n${text.slice(-2000)}`);
  return { text, job: JSON.parse(m[1]) as RunJob };
}

/** Raw request with a chosen Host header (fetch cannot set Host). */
function rawGet(p: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port: ui.port, path: p, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end();
  });
}

beforeAll(async () => {
  tmp = await makeTmpDir("sw-ui-");
  userCfg = await makeTmpDir("sw-ui-usercfg-");
  target = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
  const port = (target.address() as AddressInfo).port;
  mkdirSync(tmp.join("src"));
  // One risky call so `inspect` has a finding (outbound HTTP without a timeout).
  writeFileSync(
    tmp.join("src", "pay.ts"),
    'export async function charge(): Promise<Response> {\n  return fetch("http://127.0.0.1:9/pay");\n}\n',
  );
  cfgPath = tmp.join("sw.config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      project: { name: "ui-it" },
      targets: { api: { url: `http://127.0.0.1:${port}`, health: "/" } },
      performance: {
        target: "api",
        rate: 20,
        duration: "1s",
        scenarios: [{ name: "s", steps: [{ path: "/" }] }],
      },
      architecture: { include: ["src/**/*.ts"] },
    }),
  );
  mkdirSync(tmp.join("assets"));
  writeFileSync(tmp.join("assets", "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(tmp.join("assets", "app.js"), "export {};");
  const env = { SW_USER_CONFIG_DIR: userCfg.path, CI: "1" };
  const loadWorld = () => createWorld({ cwd: tmp.path, config: cfgPath, env: { ...process.env, ...env } });
  ui = await startUiServer({
    loadWorld,
    runner: new JobRunner({
      file: process.execPath,
      prefix: ["--import", TSX_LOADER, CLI_ENTRY],
      cwd: tmp.path,
      env,
    }),
    assets: loadAssets(tmp.join("assets")),
    version: "test",
    globals: ["--config", cfgPath],
    scenarios: listScenarios().map((s) => ({ id: s.id, title: s.title })),
    doctor: async () => ({ checks: [{ status: "ok", label: "node" }] }),
    port: 0,
  });
}, 60_000);

afterAll(async () => {
  await ui?.close();
  await new Promise<void>((r) => (target ? target.close(() => r()) : r()));
  await tmp?.cleanup();
  await userCfg?.cleanup();
});

describe("sw ui server: security", () => {
  it("listens on loopback and hands out a fragment-only token", () => {
    expect(ui.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(ui.openUrl).toBe(`${ui.url}#t=${ui.token}`);
  });

  it("static files are served with strict headers; the API needs the token", async () => {
    const page = await fetch(ui.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    expect((await api("/api/session", { token: null })).status).toBe(401);
    expect((await api("/api/session", { token: "wrong" })).status).toBe(401);
    expect((await api(`/api/session?t=${ui.token}`, { token: null })).status).toBe(401); // query token only for SSE
    expect((await api("/api/nope")).status).toBe(404);
    expect((await fetch(`${ui.url}../package.json`)).status).toBe(404);
    expect((await fetch(`${ui.url}sw.config.json`)).status).toBe(404);
  });

  it("refuses foreign Host headers (DNS rebinding) and cross-origin writes", async () => {
    expect(await rawGet("/", { Host: "evil.example" })).toBe(421);
    expect(
      await rawGet("/api/session", { Host: `evil.example:${ui.port}`, Authorization: `Bearer ${ui.token}` }),
    ).toBe(421);
    expect(await rawGet("/", { Host: `localhost:${ui.port}` })).toBe(200);
    const cross = await api("/api/jobs", {
      method: "POST",
      body: { engine: "inspect" },
      headers: { Origin: "http://evil.example" },
    });
    expect(cross.status).toBe(403);
    const form = await fetch(`${ui.url}api/jobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ui.token}`, "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(form.status).toBe(415);
  });

  it("validates job requests before anything runs", async () => {
    const bad = await api<{ error: { code: string; issues: string[] } }>("/api/jobs", {
      method: "POST",
      body: { engine: "perf", options: { duration: "--target=http://evil.example" } },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.issues[0]).toMatch(/duration/i);
    const confirm = await api<{ error: { code: string; needs: string[] } }>("/api/jobs", {
      method: "POST",
      body: { engine: "reliability", options: { scenario: "dependency-5xx" } },
    });
    expect(confirm.status).toBe(428);
    expect(confirm.json.error).toMatchObject({ code: "CONFIRM_REQUIRED", needs: ["disruptive"] });
    expect((await api("/api/runs/..%2F..%2Fx")).status).toBe(404);
    expect((await api("/api/runs/01M6Z90RJMX1MJMZ26VRG4C6Y4/report.exe")).status).toBe(404);
    expect((await api("/api/runs/diff?baseline=x&current=y")).status).toBe(400);
    const big = await api("/api/jobs", {
      method: "POST",
      body: { engine: "inspect", pad: "x".repeat(70_000) },
    });
    expect(big.status).toBe(413);
  });
});

describe("sw ui server: data and jobs", () => {
  it("session, targets, config (masked) and doctor", async () => {
    const s = await api<SessionInfo>("/api/session");
    expect(s.status).toBe(200);
    expect(s.json.project).toMatchObject({ name: "ui-it", configPath: cfgPath });
    expect(s.json.engines.map((e) => e.id)).toContain("bugs");
    expect(s.json.running).toBeNull();
    const t = await api<{ targets: Array<{ name: string; health: { ok: boolean } }> }>("/api/targets");
    expect(t.json.targets).toEqual([
      expect.objectContaining({ name: "api", health: expect.objectContaining({ ok: true }) }),
    ]);
    expect((await api<{ path: string }>("/api/config")).json.path).toBe(cfgPath);
    expect((await api("/api/doctor")).status).toBe(200);
    expect((await api<RunsPage>("/api/runs")).json).toEqual({ runs: [], next: null });
  });

  it("a test runs as a child `sw`, streams its output and lands in history", async () => {
    const started = await api<{ job: RunJob }>("/api/jobs", {
      method: "POST",
      body: { engine: "inspect", label: "ui-it" },
    });
    expect(started.status).toBe(202);
    expect(started.json.job.command).toMatch(/^sw --config .*sw\.config\.json"? --label ui-it inspect$/);
    const busy = await api("/api/jobs", { method: "POST", body: { engine: "inspect" } });
    expect(busy.status).toBe(409);
    const { text, job } = await waitForEnd(started.json.job.id);
    expect(job.state).toBe("finished");
    expect(job.exitCode, text.slice(-1500)).toBe(1); // the outbound call without timeout is a high finding
    expect(job.runId).toMatch(/^[0-9A-Z]{26}$/);
    expect(text).toContain("event: line");

    const runs = await api<RunsPage>("/api/runs");
    expect(runs.json.runs[0]).toMatchObject({ id: job.runId, label: "ui-it", engines: ["architecture"] });
    const detail = await api<RunDetail>(`/api/runs/${job.runId}`);
    expect(detail.json.exitCode).toBe(1);
    expect(JSON.stringify(detail.json.report)).toContain("ARCH001");
    for (const [fmt, type] of [
      ["json", "application/json"],
      ["md", "text/markdown"],
      ["html", "text/html"],
      ["sarif", "application/sarif+json"],
      ["junit", "application/xml"],
    ] as const) {
      const r = await fetch(`${ui.url}api/runs/${job.runId}/report.${fmt}`, {
        headers: { Authorization: `Bearer ${ui.token}` },
      });
      expect(r.status, fmt).toBe(200);
      expect(r.headers.get("content-type")).toContain(type);
      expect(r.headers.get("content-disposition")).toContain(`second-world-${job.runId}`);
      expect((await r.text()).length).toBeGreaterThan(50);
    }
    const f = await api<{ findings: Array<{ ruleId: string; open: boolean; lastRunId: string }> }>(
      "/api/findings",
    );
    expect(f.json.findings).toContainEqual(
      expect.objectContaining({ ruleId: "ARCH001", open: true, lastRunId: job.runId }),
    );

    // A finished job can still be watched (reloaded page): buffered lines + end.
    const again = await waitForEnd(job.id, 10_000);
    expect(again.job.runId).toBe(job.runId);
  }, 180_000);

  it("a dry run sends nothing and saves nothing", async () => {
    const before = (await api<RunsPage>("/api/runs")).json.runs.length;
    const started = await api<{ job: RunJob }>("/api/jobs", {
      method: "POST",
      body: { engine: "perf", dryRun: true },
    });
    const { job } = await waitForEnd(started.json.job.id);
    expect(job.exitCode).toBe(0);
    expect(job.dryRun).toBe(true);
    expect(job.exitMeaning).toMatch(/nothing was sent/);
    expect((await api<RunsPage>("/api/runs")).json.runs.length).toBe(before);
  }, 120_000);

  it("Stop ends a running test gracefully (exit 130) on every OS", async () => {
    const started = await api<{ job: RunJob }>("/api/jobs", {
      method: "POST",
      body: { engine: "perf", options: { duration: "60s" } },
    });
    // Wait until the load test is really running before stopping it.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const cur = (await api<{ job: RunJob }>("/api/jobs/current")).json.job;
      expect(cur?.state).not.toBe("finished");
      const res = await fetch(`${ui.url}api/jobs/${started.json.job.id}/events?t=${ui.token}`);
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      await reader.cancel();
      if (value && new TextDecoder().decode(value).includes("event: line") && Date.now() > 0) break;
      if (Date.now() > deadline) throw new Error("the perf job never produced output");
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 2500));
    const t0 = Date.now();
    const stop = await api<{ job: RunJob }>(`/api/jobs/${started.json.job.id}/stop`, { method: "POST" });
    expect(stop.status).toBe(202);
    expect(stop.json.job.state).toBe("stopping");
    const { job, text } = await waitForEnd(started.json.job.id, 60_000);
    expect(job.exitCode, text.slice(-1500)).toBe(130);
    expect(job.exitMeaning).toBe("Stopped");
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(text).toMatch(/stopping gracefully/);
    expect((await api(`/api/jobs/${started.json.job.id}/stop`, { method: "POST" })).status).toBe(404);
  }, 150_000);
});
