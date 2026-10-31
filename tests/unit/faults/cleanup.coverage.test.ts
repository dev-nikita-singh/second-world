/**
 * Coverage tests for fault revert/cleanup error paths (src/adapters/faults/cleanup.ts;
 * docs/11 §1 "Leftover faults", docs/03-engines/reliability-lab.md §1). Owner: sw-coverage (Wave 5).
 * Uses a private ledger path per test; never touches the default ledger.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armTtl,
  CleanupStack,
  cleanupAll,
  defaultLedgerPath,
  type LedgerEntry,
  ledgerAdd,
  ledgerRemove,
  readLedger,
  registerGlobalCleanup,
  runRevertAction,
  runRevertActionSync,
} from "../../../src/adapters/faults/cleanup.js";

let dir: string;
let ledger: string;
let server: http.Server;
let base: string;
const bodies: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sw-cleanup-cov-"));
  ledger = join(dir, "sub", "ledger.json");
  bodies.length = 0;
  server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      bodies.push(`${req.method} ${req.url} ${req.headers["content-type"] ?? ""} ${b}`);
      res.writeHead(req.url === "/fail" ? 500 : req.url === "/gone" ? 404 : 200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const entry = (id: string, actions: LedgerEntry["actions"], createdAt = "t0"): LedgerEntry => ({
  id,
  injector: "inj",
  description: id,
  createdAt,
  expiresAt: 0,
  pid: process.pid,
  actions,
});

describe("CleanupStack", () => {
  it("unregister is idempotent; runAllSync runs sync variants only and swallows errors", () => {
    const changes: number[] = [];
    const s = new CleanupStack(() => changes.push(s.size));
    const ran: string[] = [];
    const un = s.push(
      "a",
      () => void ran.push("async-a"),
      () => ran.push("sync-a"),
    );
    un();
    un();
    s.push(
      "b",
      () => void ran.push("async-b"),
      () => {
        throw new Error("sync boom");
      },
    );
    s.push("c", () => void ran.push("async-c"));
    s.push(
      "d",
      () => void ran.push("async-d"),
      () => ran.push("sync-d"),
    );
    expect(s.names()).toEqual(["b", "c", "d"]);
    expect(() => s.runAllSync()).not.toThrow();
    expect(ran).toEqual(["sync-d"]);
    expect(s.size).toBe(0);
    expect(changes.length).toBeGreaterThan(3);
  });

  it("runAll continues after throwing and rejecting callbacks", async () => {
    const s = new CleanupStack();
    s.push("sync-throw", () => {
      throw new Error("x");
    });
    s.push("reject", () => Promise.reject("str-reason"));
    s.push("ok", () => undefined);
    const errs = await s.runAll();
    expect(errs.map((e) => e.name)).toEqual(["reject", "sync-throw"]);
    expect(await s.runAll()).toEqual([]);
  });
});

describe("armTtl", () => {
  it("non-positive / non-finite TTLs never fire; a rejecting revert is swallowed", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      armTtl(0, fn)();
      armTtl(-5, fn);
      armTtl(Number.NaN, fn);
      armTtl(Number.POSITIVE_INFINITY, fn);
      const bad = vi.fn(() => Promise.reject(new Error("revert failed")));
      armTtl(10, bad);
      await vi.advanceTimersByTimeAsync(20);
      expect(fn).not.toHaveBeenCalled();
      expect(bad).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ledger", () => {
  it("defaultLedgerPath honours SW_FAULT_LEDGER", () => {
    vi.stubEnv("SW_FAULT_LEDGER", join(dir, "x.json"));
    expect(defaultLedgerPath()).toBe(join(dir, "x.json"));
  });

  it("readLedger: missing, non-array and corrupt files read as empty", () => {
    expect(readLedger(ledger)).toEqual([]);
    writeFileSync(join(dir, "obj.json"), '{"a":1}');
    expect(readLedger(join(dir, "obj.json"))).toEqual([]);
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(readLedger(join(dir, "bad.json"))).toEqual([]);
  });

  it("a corrupt ledger is moved aside to .corrupt, never silently overwritten", () => {
    const p = join(dir, "l.json");
    writeFileSync(p, "{torn");
    ledgerAdd(entry("a", []), p);
    expect(readFileSync(`${p}.corrupt`, "utf8")).toBe("{torn");
    expect(readLedger(p).map((e) => e.id)).toEqual(["a"]);
    writeFileSync(p, '{"not":"array"}');
    ledgerAdd(entry("b", []), p);
    expect(readLedger(p).map((e) => e.id)).toEqual(["b"]);
  });

  it("re-adding an id replaces it; removing an absent id is a no-op; removing the last deletes the file", () => {
    ledgerAdd(entry("a", [], "t1"), ledger);
    ledgerAdd(entry("a", [], "t2"), ledger);
    expect(readLedger(ledger)).toHaveLength(1);
    expect(readLedger(ledger)[0]?.createdAt).toBe("t2");
    ledgerRemove("zzz", ledger);
    ledgerRemove("a", ledger, "t1"); // wrong createdAt: kept
    expect(readLedger(ledger)).toHaveLength(1);
    ledgerRemove("a", ledger);
    expect(existsSync(ledger)).toBe(false);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
  });

  it("a stale lock left by a crashed writer is broken", () => {
    ledgerAdd(entry("a", []), ledger);
    const lock = `${ledger}.lock`;
    writeFileSync(lock, "99999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    ledgerAdd(entry("b", []), ledger);
    expect(
      readLedger(ledger)
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("revert actions", () => {
  it("http: JSON body is sent; 404 counts as done; 5xx throws with method + status", async () => {
    await runRevertAction({ kind: "http", method: "POST", url: `${base}/toxics`, body: { enabled: false } });
    expect(bodies[0]).toBe('POST /toxics application/json {"enabled":false}');
    await runRevertAction({ kind: "http", method: "DELETE", url: `${base}/gone` });
    await expect(runRevertAction({ kind: "http", method: "DELETE", url: `${base}/fail` })).rejects.toThrow(
      /DELETE .*\/fail → HTTP 500/,
    );
  });

  it("http: unreachable endpoint and timeout reject", async () => {
    const hang = http.createServer(() => undefined);
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const port = (hang.address() as AddressInfo).port;
    try {
      await expect(
        runRevertAction({ kind: "http", method: "DELETE", url: `http://127.0.0.1:${port}/x` }, 100),
      ).rejects.toThrow();
    } finally {
      hang.closeAllConnections();
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });

  it("exec: failure without alreadyDone match throws; sync variant ignores http and runs exec", async () => {
    await expect(
      runRevertAction({
        kind: "exec",
        file: process.execPath,
        args: ["-e", "process.stderr.write('other'); process.exit(2)"],
        alreadyDone: "is not paused",
      }),
    ).rejects.toThrow();
    await expect(
      runRevertAction({ kind: "exec", file: process.execPath, args: ["-e", "process.exit(2)"] }),
    ).rejects.toThrow();
    const marker = join(dir, "sync-ran");
    runRevertActionSync({ kind: "http", method: "DELETE", url: `${base}/never` });
    runRevertActionSync({
      kind: "exec",
      file: process.execPath,
      args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`],
    });
    expect(existsSync(marker)).toBe(true);
    expect(bodies).toEqual([]);
  });
});

describe("cleanupAll", () => {
  it("runs the global stack, replays the ledger, keeps failed entries and reports errors", async () => {
    let ran = 0;
    registerGlobalCleanup("ok", () => void ran++);
    registerGlobalCleanup("bad", () => {
      throw "plain string";
    });
    ledgerAdd(entry("good", [{ kind: "http", method: "DELETE", url: `${base}/toxic` }]), ledger);
    ledgerAdd(entry("broken", [{ kind: "http", method: "DELETE", url: `${base}/fail` }]), ledger);
    const r = await cleanupAll({ ledgerPath: ledger });
    expect(r.inProcess).toBe(2);
    expect(r.ledger).toBe(2);
    expect(ran).toBe(1);
    expect(r.errors).toEqual(
      expect.arrayContaining([
        { name: "bad", message: "plain string" },
        { name: "inj:broken", message: expect.stringContaining("HTTP 500") },
      ]),
    );
    expect(readLedger(ledger).map((e) => e.id)).toEqual(["broken"]);
  });
});
