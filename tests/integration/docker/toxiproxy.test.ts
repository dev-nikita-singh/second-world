/**
 * LIVE: Toxiproxy injector (src/adapters/faults/toxiproxy.ts) against a real ghcr.io/shopify/toxiproxy
 * container. docs/03-engines/reliability-lab.md §1, §4 (dependency-latency).
 *
 * Two upstreams: a containered HTTP server on a shared labelled network, and an HTTP server on the host
 * (reached from the Toxiproxy container via host.docker.internal). Latency is measured with fresh
 * connections before, during and after the fault; the toxic and the proxy must be gone afterwards —
 * including after a hard crash, via `sw reliability cleanup --ledger`. The reliability engine's
 * dependency-latency scenario is also run end-to-end through the toxiproxy injector. Skipped without Docker.
 */
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readLedger } from "../../../src/adapters/faults/cleanup.js";
import { ToxiproxyInjector } from "../../../src/adapters/faults/toxiproxy.js";
import { runReliability } from "../../../src/engines/reliability/index.js";
import { REPO_ROOT, runCli } from "../../helpers/cli.js";
import { type Listening, listenOnRandomPort } from "../../helpers/servers.js";
import {
  docker,
  dockerAvailable,
  ensureImage,
  publishedPort,
  removeLabelled,
  TEST_LABEL,
  waitFor,
} from "./helpers.js";

const TOXI_IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0";
const NODE_IMAGE = "node:22-alpine";
const TOXI = `sw-test-toxi-${process.pid}`;
const UP = `sw-test-up-${process.pid}`;
const NET = `sw-test-toxinet-${process.pid}`;
/** Ports inside the Toxiproxy container used as proxy listeners (published to random host ports). */
const LISTEN_A = 21000;
const LISTEN_B = 21001;
const LISTEN_C = 21002;
const TSX = pathToFileURL(path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const CHILD = path.join(import.meta.dirname, "fixtures", "fault-crash-child.ts");

let api = "";
const hostPort: Record<number, number> = {};
let hostUpstream: Listening;
let dir = "";
let ledger = "";

/** One request on a fresh TCP connection (agent: false), returns latency in ms or null on error. */
function timedGet(port: number, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = http.get({ host: "127.0.0.1", port, path: "/", agent: false, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200 ? performance.now() - t0 : null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

async function median(port: number, n = 7): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = await timedGet(port);
    if (v === null) throw new Error(`request via proxy port ${port} failed`);
    xs.push(v);
  }
  xs.sort((a, b) => a - b);
  return xs[Math.floor(n / 2)] as number;
}

async function proxies(): Promise<Record<string, { toxics: { name: string }[] }>> {
  const r = await fetch(`${api}/proxies`);
  return (await r.json()) as Record<string, { toxics: { name: string }[] }>;
}

describe.skipIf(!dockerAvailable)("LIVE toxiproxy injector", () => {
  beforeAll(async () => {
    await ensureImage(TOXI_IMAGE, 600_000);
    await ensureImage(NODE_IMAGE, 600_000);
    dir = mkdtempSync(path.join(tmpdir(), "sw-dkr-toxi-"));
    ledger = path.join(dir, "ledger.json");
    await removeLabelled(TEST_LABEL);
    hostUpstream = await listenOnRandomPort(http.createServer((_q, s) => s.end("host upstream")));
    await docker(["network", "create", "--label", TEST_LABEL, NET], { reject: true });
    await docker(
      [
        "run",
        "-d",
        "--name",
        UP,
        "--label",
        TEST_LABEL,
        "--network",
        NET,
        NODE_IMAGE,
        "node",
        "-e",
        `require("http").createServer((q, s) => s.end("container upstream")).listen(8080, "0.0.0.0")`,
      ],
      { reject: true },
    );
    await docker(
      [
        "run",
        "-d",
        "--name",
        TOXI,
        "--label",
        TEST_LABEL,
        "--network",
        NET,
        "-p",
        "127.0.0.1::8474",
        "-p",
        `127.0.0.1::${LISTEN_A}`,
        "-p",
        `127.0.0.1::${LISTEN_B}`,
        "-p",
        `127.0.0.1::${LISTEN_C}`,
        TOXI_IMAGE,
        "-host",
        "0.0.0.0",
      ],
      { reject: true },
    );
    api = `http://127.0.0.1:${await publishedPort(TOXI, 8474)}`;
    for (const p of [LISTEN_A, LISTEN_B, LISTEN_C]) hostPort[p] = await publishedPort(TOXI, p);
    const up = await waitFor(async () => {
      try {
        return (await fetch(`${api}/version`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    }, 30_000);
    expect(up).toBe(true);
  }, 900_000);

  afterAll(async () => {
    await hostUpstream?.close();
    await removeLabelled(TEST_LABEL);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("dependency latency (containered upstream): +300 ms while applied, gone after revert; close() deletes the created proxy", async () => {
    const inj = new ToxiproxyInjector({
      apiUrl: api,
      proxy: "sw-test-up",
      create: { listen: `0.0.0.0:${LISTEN_A}`, upstream: `${UP}:8080` },
      ledgerPath: ledger,
      watchdog: false,
    });
    expect((await inj.capabilities()).available).toBe(true);
    await inj.ensureProxy();
    const port = hostPort[LISTEN_A] as number;
    expect(await waitFor(async () => (await timedGet(port)) !== null, 15_000)).toBe(true);
    const before = await median(port);
    const f = await inj.apply({ type: "latency", latencyMs: 300 });
    expect((await proxies())["sw-test-up"]?.toxics.map((t) => t.name)).toEqual([f.id]);
    const during = await median(port);
    await f.revert();
    const after = await median(port);
    console.log(
      `containered upstream: before ${before.toFixed(1)} ms, during ${during.toFixed(1)} ms, after ${after.toFixed(1)} ms`,
    );
    expect(during - before).toBeGreaterThan(270);
    expect(during - before).toBeLessThan(800);
    expect(after).toBeLessThan(before + 100);
    expect((await proxies())["sw-test-up"]?.toxics).toEqual([]);
    expect(readLedger(ledger).map((e) => e.id)).toEqual([expect.stringMatching(/^sw-proxy-/)]);
    await inj.close();
    expect(Object.keys(await proxies())).not.toContain("sw-test-up");
    expect(readLedger(ledger)).toEqual([]);
  }, 120_000);

  it("dependency latency (host upstream via host.docker.internal)", async () => {
    const inj = new ToxiproxyInjector({
      apiUrl: api,
      proxy: "sw-test-host",
      create: {
        listen: `0.0.0.0:${LISTEN_B}`,
        upstream: `host.docker.internal:${new URL(hostUpstream.url).port}`,
      },
      ledgerPath: ledger,
      watchdog: false,
    });
    await inj.ensureProxy();
    const port = hostPort[LISTEN_B] as number;
    expect(await waitFor(async () => (await timedGet(port)) !== null, 15_000)).toBe(true);
    const before = await median(port);
    const f = await inj.apply({ type: "latency", latencyMs: 250, jitterMs: 0 });
    const during = await median(port);
    await f.revert();
    const after = await median(port);
    console.log(
      `host upstream: before ${before.toFixed(1)} ms, during ${during.toFixed(1)} ms, after ${after.toFixed(1)} ms`,
    );
    expect(during - before).toBeGreaterThan(220);
    expect(after).toBeLessThan(before + 100);
    await inj.close();
    expect(Object.keys(await proxies())).not.toContain("sw-test-host");
  }, 120_000);

  it("reliability engine: dependency-latency scenario through the toxiproxy injector", async () => {
    // App under test: a host HTTP server that calls its dependency through the Toxiproxy proxy.
    const pre = new ToxiproxyInjector({
      apiUrl: api,
      proxy: "sw-test-dep",
      create: { listen: `0.0.0.0:${LISTEN_C}`, upstream: `${UP}:8080` },
      ledgerPath: ledger,
      watchdog: false,
    });
    await pre.ensureProxy();
    const depPort = hostPort[LISTEN_C] as number;
    const app = await listenOnRandomPort(
      http.createServer((_q, res) => {
        const t0 = performance.now();
        http
          .get({ host: "127.0.0.1", port: depPort, path: "/", agent: false, timeout: 5000 }, (r) => {
            r.resume();
            r.on("end", () => res.end(`ok ${(performance.now() - t0).toFixed(0)}`));
          })
          .on("error", () => {
            res.statusCode = 502;
            res.end("dep error");
          });
      }),
    );
    try {
      const res = await runReliability(
        {
          target: app.url,
          scenario: "dependency-latency",
          dependency: "up",
          dependencies: { up: { injector: "toxiproxy", toxiproxy: { apiUrl: api, proxy: "sw-test-dep" } } },
          params: { latency: "300ms", jitter: "0ms" },
          workload: { routes: [{ name: "r", path: "/", dependsOn: ["up"] }], rate: 10 },
          steady: "1500ms",
          duration: "2500ms",
          recovery: "1500ms",
        },
        {
          safety: (await import("../../../src/core/safety/guard.js")).createSafetyGuard(
            {},
            { interactive: false, approve: true },
          ),
        },
      );
      const d = res.data as unknown as {
        runs: { steady: { p50: number }; during: { p50: number }; recoveryPhase: { p50: number } }[];
      };
      console.log(
        `reliability status=${res.status} limitations=${res.limitations.map((l) => `${l.code}:${l.message}`).join("; ")}`,
      );
      const run = d.runs[0]!;
      console.log(
        `steady p50 ${run.steady.p50.toFixed(1)} ms, during ${run.during.p50.toFixed(1)} ms, recovery ${run.recoveryPhase.p50.toFixed(1)} ms`,
      );
      expect(run.during.p50 - run.steady.p50).toBeGreaterThan(250);
      expect(run.recoveryPhase.p50).toBeLessThan(run.steady.p50 + 100);
      expect(res.limitations.filter((l) => l.impact === "invalidates")).toEqual([]);
      expect(["passed", "failed"]).toContain(res.status);
      // the fault was reverted: no toxic left on the proxy
      expect((await proxies())["sw-test-dep"]?.toxics).toEqual([]);
    } finally {
      await app.close();
      await pre.close();
    }
    expect(Object.keys(await proxies())).not.toContain("sw-test-dep");
  }, 180_000);

  it("crash: hard-killed process leaves toxic + created proxy; `sw reliability cleanup --ledger` removes both", async () => {
    // A user-managed proxy (not created by sw): only our toxic must be removed from it, never the proxy.
    const pr = await fetch(`${api}/proxies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "sw-test-crash",
        listen: `0.0.0.0:${LISTEN_B}`,
        upstream: `${UP}:8080`,
        enabled: true,
      }),
    });
    expect(pr.status).toBe(201);
    const r = await execa(
      process.execPath,
      [
        "--import",
        TSX,
        CHILD,
        "toxiproxy",
        ledger,
        JSON.stringify({ type: "latency", latencyMs: 500 }),
        "0",
        api,
        "sw-test-crash",
      ],
      { cwd: REPO_ROOT, reject: false, timeout: 60_000, windowsHide: true },
    );
    expect(String(r.stdout)).toMatch(/APPLIED/);
    // the crash child does not pass `create`; make the proxy-creation path crash too:
    const created = new ToxiproxyInjector({
      apiUrl: api,
      proxy: "sw-test-crash2",
      create: { listen: `0.0.0.0:${LISTEN_A}`, upstream: `${UP}:8080` },
      ledgerPath: ledger,
      watchdog: false,
    });
    await created.ensureProxy(); // ledger entry for the proxy; never closed (simulated crash)
    expect(Object.keys(await proxies())).toContain("sw-test-crash2");
    expect(readLedger(ledger).length).toBe(2);
    const c = await runCli(["reliability", "cleanup", "--ledger", ledger, "--json"], { timeoutMs: 60_000 });
    console.log(`$ sw reliability cleanup --ledger <tmp>/ledger.json --json\n${c.stdout}${c.stderr}`);
    expect(c.exitCode).toBe(0);
    expect(JSON.parse(c.stdout)).toMatchObject({ ledger: 2, errors: [] });
    const after = await proxies();
    expect(Object.keys(after)).not.toContain("sw-test-crash2");
    expect(after["sw-test-crash"]?.toxics).toEqual([]);
    expect(readLedger(ledger)).toEqual([]);
    await fetch(`${api}/proxies/sw-test-crash`, { method: "DELETE" });
  }, 120_000);
});
