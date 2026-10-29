import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  armTtl,
  CleanupStack,
  cleanupAll,
  cleanupHooksInstalled,
  pendingGlobalCleanups,
  type RevertAction,
  readLedger,
  registerGlobalCleanup,
  spawnWatchdog,
} from "../../../src/adapters/faults/cleanup.js";
import { DockerInjector } from "../../../src/adapters/faults/docker.js";
import { ToxiproxyInjector } from "../../../src/adapters/faults/toxiproxy.js";
import { type Listening, listenOnRandomPort } from "../../helpers/servers.js";

let dir: string;
let ledgerPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sw-rel-"));
  ledgerPath = join(dir, "ledger.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("CleanupStack", () => {
  it("runs callbacks LIFO, once, and collects errors", async () => {
    const order: string[] = [];
    const s = new CleanupStack();
    s.push("a", () => {
      order.push("a");
    });
    s.push("b", () => {
      throw new Error("boom");
    });
    const un = s.push("c", () => {
      order.push("c");
    });
    s.push("d", async () => {
      order.push("d");
    });
    un();
    const errors = await s.runAll();
    expect(order).toEqual(["d", "a"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.name).toBe("b");
    expect(s.size).toBe(0);
    expect(await s.runAll()).toEqual([]);
  });

  it("global stack installs signal hooks only while non-empty", async () => {
    const before = cleanupHooksInstalled();
    let ran = 0;
    const un = registerGlobalCleanup("t1", () => {
      ran++;
    });
    expect(cleanupHooksInstalled()).toBe(true);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
    un();
    expect(cleanupHooksInstalled()).toBe(before);
    registerGlobalCleanup("t2", () => {
      ran++;
    });
    const r = await cleanupAll({ ledgerPath });
    expect(r.inProcess).toBeGreaterThanOrEqual(1);
    expect(ran).toBe(1);
    expect(pendingGlobalCleanups()).toEqual([]);
  });

  it("armTtl fires after the ttl unless disarmed", async () => {
    let fired = 0;
    armTtl(30, () => {
      fired++;
    });
    const disarm = armTtl(30, () => {
      fired += 10;
    });
    disarm();
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(1);
  });
});

describe("DockerInjector (fake exec)", () => {
  it("maps container faults to CLI commands, ledgers the revert and reverts", async () => {
    const calls: string[] = [];
    const exec = async (a: RevertAction): Promise<void> => {
      if (a.kind === "exec") calls.push(`${a.file} ${a.args.join(" ")}`);
    };
    const inj = new DockerInjector({ exec, probe: async () => "29.0", ledgerPath, watchdog: false });
    expect((await inj.capabilities()).available).toBe(true);
    const f = await inj.apply({ type: "container", action: "pause", container: "payments" });
    expect(calls).toEqual(["docker pause payments"]);
    expect(readLedger(ledgerPath)).toHaveLength(1);
    expect(pendingGlobalCleanups().some((n) => n.startsWith("docker:"))).toBe(true);
    await f.revert();
    expect(calls).toEqual(["docker pause payments", "docker unpause payments"]);
    expect(readLedger(ledgerPath)).toHaveLength(0);
    expect(pendingGlobalCleanups().some((n) => n.startsWith("docker:"))).toBe(false);

    await inj.apply({ type: "container", action: "network-disconnect", container: "db", network: "net1" });
    await inj.apply({ type: "container", action: "stop", container: "cache" });
    await inj.revert();
    expect(calls.slice(2)).toEqual([
      "docker network disconnect net1 db",
      "docker stop -t 1 cache",
      "docker network connect net1 db",
      "docker start cache",
    ]);
  });

  it("revert actions carry an alreadyDone pattern; ledger replay treats 'is not paused' as reverted", async () => {
    const inj = new DockerInjector({
      exec: async () => {},
      probe: async () => "1",
      ledgerPath,
      watchdog: false,
    });
    await inj.apply({ type: "container", action: "pause", container: "x" });
    const [entry] = readLedger(ledgerPath);
    const action = entry?.actions[0] as Extract<RevertAction, { kind: "exec" }>;
    expect(action.args).toEqual(["unpause", "x"]);
    expect(new RegExp(action.alreadyDone as string, "i").test("Container abc is not paused")).toBe(true);
    // replay with a command that fails with that message → counts as done, entry cleared
    const fake: RevertAction = {
      kind: "exec",
      file: process.execPath,
      args: ["-e", "console.error('Error response from daemon: Container 1 is not paused'); process.exit(1)"],
      alreadyDone: action.alreadyDone as string,
    };
    const { ledgerAdd } = await import("../../../src/adapters/faults/cleanup.js");
    ledgerAdd({ ...(entry as NonNullable<typeof entry>), actions: [fake] }, ledgerPath);
    const r = await cleanupAll({ ledgerPath });
    expect(r.errors).toEqual([]);
    expect(readLedger(ledgerPath)).toEqual([]);
    // without the pattern the same failure is an error and the entry stays
    ledgerAdd(
      { ...(entry as NonNullable<typeof entry>), actions: [{ ...fake, alreadyDone: undefined }] },
      ledgerPath,
    );
    const r2 = await cleanupAll({ ledgerPath });
    expect(r2.errors).toHaveLength(1);
    expect(readLedger(ledgerPath)).toHaveLength(1);
    await inj.close();
  });

  it("refuses to stop a container started with --rm (the revert could never restore it)", async () => {
    const calls: string[] = [];
    const inj = new DockerInjector({
      exec: async (a) => {
        if (a.kind === "exec") calls.push(a.args.join(" "));
      },
      probe: async () => "1",
      inspect: async (c) => (c === "ephemeral" ? "true" : "false"),
      ledgerPath,
      watchdog: false,
    });
    await expect(inj.apply({ type: "container", action: "stop", container: "ephemeral" })).rejects.toThrow(
      /--rm/,
    );
    expect(calls).toEqual(["start ephemeral"]); // never stopped; the failed apply only runs the idempotent revert
    expect(readLedger(ledgerPath)).toEqual([]);
    await inj.apply({ type: "container", action: "stop", container: "kept" });
    expect(calls.at(-1)).toBe("stop -t 1 kept");
    await inj.close();
    expect(readLedger(ledgerPath)).toEqual([]);
  });

  it("is unavailable when the daemon is not reachable and refuses non-container faults", async () => {
    const inj = new DockerInjector({ probe: async () => null, ledgerPath, watchdog: false });
    const caps = await inj.capabilities();
    expect(caps.available).toBe(false);
    await expect(inj.apply({ type: "container", action: "pause", container: "x" })).rejects.toThrow(
      /unavailable/,
    );
    const ok = new DockerInjector({
      probe: async () => "1",
      ledgerPath,
      watchdog: false,
      exec: async () => {},
    });
    await expect(ok.apply({ type: "latency", latencyMs: 10 })).rejects.toThrow(/does not support/);
  });

  it("tolerates 'no such container' on revert but not on apply", async () => {
    const exec = async (a: RevertAction): Promise<void> => {
      if (a.kind === "exec") throw new Error("Error response from daemon: No such container: ghost");
    };
    const inj = new DockerInjector({ exec, probe: async () => "1", ledgerPath, watchdog: false });
    await expect(inj.apply({ type: "container", action: "pause", container: "ghost" })).rejects.toThrow(
      /No such container/,
    );
    expect(inj.active()).toEqual([]);
    expect(readLedger(ledgerPath)).toHaveLength(0);
  });

  it("keeps the ledger entry when revert fails, cleanupAll replays it", async () => {
    let fail = true;
    const calls: string[] = [];
    const exec = async (a: RevertAction): Promise<void> => {
      if (a.kind !== "exec") return;
      if (a.args[0] === "unpause" && fail) throw new Error("daemon down");
      calls.push(a.args.join(" "));
    };
    const inj = new DockerInjector({ exec, probe: async () => "1", ledgerPath, watchdog: false });
    await inj.apply({ type: "container", action: "pause", container: "nope-container-sw" });
    await expect(inj.revert()).rejects.toThrow(/daemon down/);
    expect(readLedger(ledgerPath)).toHaveLength(1);
    fail = false;
    await inj.revert();
    expect(readLedger(ledgerPath)).toHaveLength(0);
    expect(calls).toContain("unpause nope-container-sw");
  });
});

describe("ToxiproxyInjector (fake REST server)", () => {
  let api: Listening;
  const toxics = new Map<string, Record<string, unknown>>();
  const proxies = new Map<string, Record<string, unknown>>();

  beforeEach(async () => {
    toxics.clear();
    proxies.clear();
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
        : {};
      const send = (status: number, v?: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(v === undefined ? "" : JSON.stringify(v));
      };
      const url = req.url ?? "/";
      if (url === "/version") return send(200, "2.9.0");
      if (url === "/proxies" && req.method === "POST") {
        proxies.set(String(body.name), body);
        return send(201, body);
      }
      const m = /^\/proxies\/([^/]+)(\/toxics(?:\/([^/]+))?)?$/.exec(url);
      if (!m) return send(404);
      const name = decodeURIComponent(m[1] ?? "");
      if (!proxies.has(name)) return send(404, { error: "proxy not found" });
      if (!m[2] && req.method === "DELETE") {
        proxies.delete(name);
        return send(204);
      }
      if (!m[2]) return send(200, proxies.get(name));
      if (req.method === "POST") {
        toxics.set(String(body.name), body);
        return send(200, body);
      }
      if (req.method === "GET") return send(200, [...toxics.values()]);
      if (req.method === "DELETE") {
        const t = decodeURIComponent(m[3] ?? "");
        return toxics.delete(t) ? send(204) : send(404);
      }
      return send(405);
    });
    api = await listenOnRandomPort(server);
  });
  afterEach(async () => {
    await api.close();
  });

  it("creates the proxy, adds/removes toxics with mapped attributes", async () => {
    const inj = new ToxiproxyInjector({
      apiUrl: api.url,
      proxy: "payments",
      create: { listen: "127.0.0.1:0", upstream: "127.0.0.1:4010" },
      ledgerPath,
      watchdog: false,
    });
    expect((await inj.capabilities()).available).toBe(true);
    const f = await inj.apply({ type: "latency", latencyMs: 200, jitterMs: 20, percent: 50 });
    expect(proxies.has("payments")).toBe(true);
    const t = [...toxics.values()][0] as {
      type: string;
      toxicity: number;
      attributes: Record<string, number>;
    };
    expect(t.type).toBe("latency");
    expect(t.toxicity).toBe(0.5);
    expect(t.attributes).toEqual({ latency: 200, jitter: 20 });
    // toxic revert + deletion of the proxy this injector created
    expect(readLedger(ledgerPath)).toHaveLength(2);
    await f.revert();
    expect(toxics.size).toBe(0);
    expect(readLedger(ledgerPath).map((e) => e.id)).toEqual([expect.stringMatching(/^sw-proxy-/)]);

    await inj.apply({ type: "blackhole" });
    expect([...toxics.values()][0]?.type).toBe("timeout");
    await expect(inj.apply({ type: "http-status", status: 503 })).rejects.toThrow(/does not support/);
    // leftover cleanup from a "crashed" run: ledger replay deletes the toxic
    const r = await cleanupAll({ ledgerPath });
    expect(r.errors).toEqual([]);
    expect(toxics.size).toBe(0);
    expect(proxies.has("payments")).toBe(false); // created by sw → removed from the ledger too
    expect(readLedger(ledgerPath)).toEqual([]);
  });

  it("close() deletes a proxy it created, never one that already existed", async () => {
    const created = new ToxiproxyInjector({
      apiUrl: api.url,
      proxy: "mine",
      create: { listen: "127.0.0.1:0", upstream: "127.0.0.1:4010" },
      ledgerPath,
      watchdog: false,
    });
    await created.apply({ type: "latency", latencyMs: 10 });
    await created.close();
    expect(proxies.has("mine")).toBe(false);
    expect(toxics.size).toBe(0);
    expect(readLedger(ledgerPath)).toEqual([]);

    proxies.set("theirs", { name: "theirs" });
    const existing = new ToxiproxyInjector({
      apiUrl: api.url,
      proxy: "theirs",
      create: { listen: "127.0.0.1:0", upstream: "127.0.0.1:4010" },
      ledgerPath,
      watchdog: false,
    });
    await existing.apply({ type: "latency", latencyMs: 10 });
    await existing.close();
    expect(proxies.has("theirs")).toBe(true);
    expect(readLedger(ledgerPath)).toEqual([]);
  });

  it("reports unavailable when the API is unreachable", async () => {
    const inj = new ToxiproxyInjector({
      apiUrl: "http://127.0.0.1:1",
      proxy: "x",
      ledgerPath,
      watchdog: false,
      probeTimeoutMs: 500,
    });
    const caps = await inj.capabilities();
    expect(caps.available).toBe(false);
    expect(caps.reason).toMatch(/not reachable/);
  });

  it("detached watchdog process runs the revert after the TTL (survives without this process's timers)", async () => {
    proxies.set("p2", { name: "p2" });
    toxics.set("sw-wd", { name: "sw-wd" });
    spawnWatchdog(300, [{ kind: "http", method: "DELETE", url: `${api.url}/proxies/p2/toxics/sw-wd` }]);
    const deadline = performance.now() + 10_000;
    while (toxics.has("sw-wd") && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(toxics.has("sw-wd")).toBe(false);
  }, 15_000);
});
