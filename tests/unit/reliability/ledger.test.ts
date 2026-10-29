/**
 * Fault ledger: atomic lock-free writes and the detached watchdog clearing its own entry
 * (docs/11-safety-security-privacy.md §1 "Leftover faults"; src/adapters/faults/cleanup.ts).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LedgerEntry,
  ledgerAdd,
  ledgerRemove,
  type RevertAction,
  readLedger,
  spawnWatchdog,
} from "../../../src/adapters/faults/cleanup.js";
import { type Listening, listenOnRandomPort } from "../../helpers/servers.js";

const REPO = path.resolve(import.meta.dirname, "../../..");
const TSX = pathToFileURL(path.join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;
const WRITER = path.join(import.meta.dirname, "fixtures", "ledger-writer.ts");

let dir: string;
let ledger: string;
let api: Listening;
const hits: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sw-ledger-"));
  ledger = path.join(dir, "ledger.json");
  hits.length = 0;
  api = await listenOnRandomPort(
    http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(req.url?.startsWith("/fail") ? 500 : req.url?.startsWith("/gone") ? 404 : 204).end();
    }),
  );
});
afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

const entry = (id: string, actions: RevertAction[], createdAt = "2026-10-29T10:00:00.000Z"): LedgerEntry => ({
  id,
  injector: "test",
  description: id,
  createdAt,
  expiresAt: 0,
  pid: process.pid,
  actions,
});

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

const ids = () => readLedger(ledger).map((e) => e.id);

describe("ledger writes", () => {
  it("add / remove keep other entries; remove by createdAt spares a re-applied entry", () => {
    ledgerAdd(entry("a", []), ledger);
    ledgerAdd(entry("b", []), ledger);
    ledgerAdd(entry("a", [], "2026-10-29T11:00:00.000Z"), ledger); // re-applied: replaces "a"
    expect(ids()).toEqual(["b", "a"]);
    ledgerRemove("a", ledger, "2026-10-29T10:00:00.000Z"); // stale removal: no-op
    expect(ids()).toEqual(["b", "a"]);
    ledgerRemove("a", ledger, "2026-10-29T11:00:00.000Z");
    expect(ids()).toEqual(["b"]);
    ledgerRemove("b", ledger);
    expect(existsSync(ledger)).toBe(false); // empty ledger = no file
    expect(readdirSync(dir)).toEqual([]); // no temp files left
  });

  it("concurrent writer processes: never a torn file, no lost update", async () => {
    const children = ["w1", "w2", "w3", "w4"].map((tag) =>
      execa(process.execPath, ["--import", TSX, WRITER, ledger, tag, "40"], {
        cwd: REPO,
        reject: false,
        timeout: 60_000,
      }),
    );
    let reads = 0;
    let done = false;
    const all = Promise.all(children).finally(() => {
      done = true;
    });
    while (!done) {
      try {
        const raw = readFileSync(ledger, "utf8");
        expect(() => JSON.parse(raw)).not.toThrow(); // never a half-written file
        reads++;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    const results = await all;
    for (const r of results) {
      expect(r.exitCode, String(r.stderr)).toBe(0);
      expect(String(r.stdout)).toContain("DONE");
    }
    expect(reads).toBeGreaterThan(0);
    const final = JSON.parse(readFileSync(ledger, "utf8")) as LedgerEntry[];
    for (const e of final) expect(e.id).toMatch(/^w[1-4]-\d+$/);
    // serialised writers: exactly the odd entries of every writer survive (no lost update)
    const expected = ["w1", "w2", "w3", "w4"].flatMap((t) =>
      Array.from({ length: 20 }, (_, i) => `${t}-${2 * i + 1}`),
    );
    expect(final.map((e) => e.id).sort()).toEqual(expected.sort());
    expect(readdirSync(dir).sort()).toEqual(["ledger.json"]); // no temp or lock files left
  }, 90_000);
});

describe("detached watchdog clears its own ledger entry", () => {
  it("after a successful revert it removes exactly its entry (others stay)", async () => {
    const actions: RevertAction[] = [{ kind: "http", method: "DELETE", url: `${api.url}/ok/1` }];
    ledgerAdd(entry("mine", actions), ledger);
    ledgerAdd(entry("other", []), ledger);
    spawnWatchdog(200, actions, { path: ledger, id: "mine", createdAt: "2026-10-29T10:00:00.000Z" });
    expect(await waitFor(() => !ids().includes("mine"), 10_000)).toBe(true);
    expect(hits).toEqual(["DELETE /ok/1"]);
    expect(ids()).toEqual(["other"]);
  }, 15_000);

  it("404 and exec output matching alreadyDone count as reverted", async () => {
    const actions: RevertAction[] = [
      { kind: "http", method: "DELETE", url: `${api.url}/gone/1` },
      {
        kind: "exec",
        file: process.execPath,
        args: ["-e", "process.stderr.write('Error: container x is not paused'); process.exit(1)"],
        alreadyDone: "is not paused",
      },
    ];
    ledgerAdd(entry("done", actions), ledger);
    spawnWatchdog(100, actions, { path: ledger, id: "done", createdAt: "2026-10-29T10:00:00.000Z" });
    expect(await waitFor(() => !existsSync(ledger), 10_000)).toBe(true);
  }, 15_000);

  it("a failed revert keeps the entry for `sw reliability cleanup`", async () => {
    const http500: RevertAction[] = [{ kind: "http", method: "DELETE", url: `${api.url}/fail/1` }];
    const execFail: RevertAction[] = [
      { kind: "exec", file: process.execPath, args: ["-e", "process.exit(3)"], alreadyDone: "is not paused" },
    ];
    ledgerAdd(entry("h", http500), ledger);
    ledgerAdd(entry("x", execFail), ledger);
    spawnWatchdog(100, http500, { path: ledger, id: "h", createdAt: "2026-10-29T10:00:00.000Z" });
    spawnWatchdog(100, execFail, { path: ledger, id: "x", createdAt: "2026-10-29T10:00:00.000Z" });
    expect(await waitFor(() => hits.includes("DELETE /fail/1"), 10_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 1500)); // let both watchdogs finish
    expect(ids()).toEqual(["h", "x"]);
  }, 15_000);

  it("does not remove an entry re-applied with the same id (different createdAt)", async () => {
    const actions: RevertAction[] = [{ kind: "http", method: "DELETE", url: `${api.url}/ok/2` }];
    ledgerAdd(entry("same", actions, "2026-10-29T12:00:00.000Z"), ledger);
    spawnWatchdog(100, actions, { path: ledger, id: "same", createdAt: "2026-10-29T10:00:00.000Z" });
    expect(await waitFor(() => hits.length > 0, 10_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(ids()).toEqual(["same"]);
  }, 15_000);
});
