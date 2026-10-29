/**
 * "No fault persists" after a crash (docs/11 §1 leftover faults): a child process applies a built-in
 * proxy black-hole and a Toxiproxy toxic, then dies from an uncaught exception.
 * - the proxy dies with the process (port refuses)
 * - the toxic is recorded in the ledger → `cleanupAll()` from another process removes it
 * - with the watchdog enabled, the detached watchdog removes it after the TTL on its own
 */
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupAll, readLedger } from "../../../src/adapters/faults/cleanup.js";
import { dockerServerVersion } from "../../../src/adapters/faults/docker.js";
import { type Listening, listenOnRandomPort } from "../../helpers/servers.js";
import { portRefuses } from "./helpers.js";

const REPO = path.resolve(import.meta.dirname, "../../..");
const TSX = pathToFileURL(path.join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;
const CHILD = path.join(import.meta.dirname, "fixtures", "crash-child.ts");

let api: Listening;
const toxics = new Set<string>();
let dir: string;

beforeEach(async () => {
  toxics.clear();
  dir = mkdtempSync(path.join(tmpdir(), "sw-crash-"));
  const proxies = new Set<string>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as { name?: string }) : {};
    const send = (s: number, v?: unknown): void => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(v === undefined ? "" : JSON.stringify(v));
    };
    const url = req.url ?? "/";
    if (url === "/version") return send(200, "2.9.0");
    if (url === "/proxies" && req.method === "POST") {
      proxies.add(String(body.name));
      return send(201, body);
    }
    const m = /^\/proxies\/([^/]+)(\/toxics(?:\/([^/]+))?)?$/.exec(url);
    if (!m || !proxies.has(decodeURIComponent(m[1] ?? ""))) return send(404);
    if (!m[2]) return send(200, { name: m[1] });
    if (req.method === "POST") {
      toxics.add(String(body.name));
      return send(200, body);
    }
    if (req.method === "DELETE") return toxics.delete(decodeURIComponent(m[3] ?? "")) ? send(204) : send(404);
    return send(
      200,
      [...toxics].map((name) => ({ name })),
    );
  });
  api = await listenOnRandomPort(server);
});

afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

async function crashChild(watchdog: boolean, ttlMs: number): Promise<{ port: number; ledger: string }> {
  const ledger = path.join(dir, "ledger.json");
  const r = await execa(
    process.execPath,
    ["--import", TSX, CHILD, api.url, ledger, watchdog ? "1" : "0", String(ttlMs)],
    {
      cwd: REPO,
      reject: false,
      timeout: 20_000,
    },
  );
  expect(r.exitCode).not.toBe(0);
  expect(String(r.stderr)).toMatch(/simulated crash/);
  const m = /READY (\d+)/.exec(String(r.stdout));
  expect(m).not.toBeNull();
  return { port: Number(m?.[1]), ledger };
}

describe("crash safety", () => {
  it("proxy dies with the process; ledger lets cleanupAll remove the leftover toxic", async () => {
    const { port, ledger } = await crashChild(false, 600_000);
    expect(await portRefuses(port)).toBe(true);
    expect(toxics.has("sw-crash")).toBe(true); // left behind by the crash
    // the toxic revert + the DELETE of the proxy the crashed injector created (`create`)
    expect(readLedger(ledger)).toHaveLength(2);
    const res = await cleanupAll({ ledgerPath: ledger });
    expect(res.errors).toEqual([]);
    expect(res.ledger).toBe(2);
    expect(toxics.size).toBe(0);
    expect(readLedger(ledger)).toHaveLength(0);
  }, 30_000);

  it("detached watchdog reverts the toxic after the TTL without any cleanup call", async () => {
    const { ledger } = await crashChild(true, 1500);
    const deadline = performance.now() + 10_000;
    while (toxics.has("sw-crash") && performance.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    expect(toxics.has("sw-crash")).toBe(false);
    // the watchdog also cleared the toxic's ledger entry; the created proxy's entry (no TTL: it is
    // deleted by close() or `sw reliability cleanup`) stays
    const deadline2 = performance.now() + 5_000;
    while (readLedger(ledger).length > 1 && performance.now() < deadline2)
      await new Promise((r) => setTimeout(r, 50));
    expect(readLedger(ledger).map((e) => e.id)).toEqual([expect.stringMatching(/^sw-proxy-/)]);
  }, 30_000);
});

const dockerUp = (await dockerServerVersion("docker", 3000)) !== null;

describe.skipIf(!dockerUp)("docker injector (live daemon)", () => {
  it("reports capabilities and reverts nothing-to-do faults cleanly", async () => {
    const { DockerInjector } = await import("../../../src/adapters/faults/docker.js");
    const inj = new DockerInjector({ ledgerPath: path.join(dir, "ledger.json"), watchdog: false });
    const caps = await inj.capabilities();
    expect(caps.available).toBe(true);
    expect(caps.faults).toEqual(["container"]);
    // A non-existent container: apply fails; the revert treats "no such container" as done → nothing left.
    await expect(
      inj.apply({ type: "container", action: "pause", container: "sw-no-such-container-xyz" }),
    ).rejects.toThrow();
    expect(readLedger(path.join(dir, "ledger.json"))).toHaveLength(0);
    expect(inj.active()).toEqual([]);
  }, 30_000);
});
