/**
 * SQLite history backend specifics (docs/03-engines/evidence-and-history.md §B.1): JSONL import,
 * schema migrations, verify on a damaged database, fallback when node:sqlite is unavailable, plugin
 * backend registry, export back to JSONL, warning filter. Shared behaviour: contract.test.ts.
 */
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHistoryStore,
  createJsonlStore,
  type HistoryStore,
  listHistoryBackends,
  openHistoryStore,
  registerHistoryBackend,
} from "../../../src/engines/history/index.js";
import { isNodeSqliteWarning, loadNodeSqlite } from "../../../src/engines/history/sqlite-load.js";
import {
  createSqliteStore,
  exportSqliteHistoryToJsonl,
  SQLITE_FILE,
  SQLITE_SCHEMA_VERSION,
  SqliteUnavailableError,
} from "../../../src/engines/history/sqlite-store.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";
import { makeClock, perfResult } from "./contract.js";

let tmp: TmpDir;
let iso: () => string;
beforeEach(async () => {
  tmp = await makeTmpDir("sw-sqlite-");
  iso = makeClock();
});
afterEach(async () => {
  await tmp.cleanup();
});

const histDir = (): string => path.join(tmp.path, ".second-world", "history");

/** Raw access to the store's database for tampering. */
async function withRawDb<T>(
  fn: (db: InstanceType<typeof import("node:sqlite").DatabaseSync>) => T,
): Promise<T> {
  const m = await loadNodeSqlite();
  if (!m) throw new Error("node:sqlite unavailable");
  const db = new m.DatabaseSync(path.join(histDir(), SQLITE_FILE));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function seedJsonl(n: number): Promise<{ jsonl: HistoryStore; ids: string[] }> {
  const jsonl = createJsonlStore({ cwd: tmp.path, isoNow: iso, captureGit: false });
  const ids: string[] = [];
  for (let i = 0; i < n; i++)
    ids.push((await jsonl.append({ results: [perfResult(100 + i, i === 0 ? [{ title: "x" }] : [])] })).id);
  return { jsonl, ids };
}

describe("SQLite store: database setup", () => {
  it("creates history.db in WAL mode with a schema_migrations table and user_version", async () => {
    const s = await createSqliteStore({ cwd: tmp.path, isoNow: iso, captureGit: false });
    await s.append({ results: [perfResult(1)] });
    const info = await withRawDb((db) => ({
      mode: (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      version: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      migrations: db.prepare("SELECT version, name FROM schema_migrations").all(),
    }));
    expect(info.mode).toBe("wal");
    expect(info.version).toBe(SQLITE_SCHEMA_VERSION);
    expect(info.migrations.map((m) => ({ ...m }))).toEqual([{ version: 1, name: "initial" }]);
  });

  it("refuses a database written by a newer SECOND WORLD (schema version ahead)", async () => {
    await createSqliteStore({ cwd: tmp.path, captureGit: false });
    await withRawDb((db) => db.exec("PRAGMA user_version = 99"));
    await expect(createSqliteStore({ cwd: tmp.path, captureGit: false })).rejects.toMatchObject({
      code: "SW_HISTORY_BACKEND",
      message: expect.stringMatching(/schema version 99.*Upgrade/),
    });
  });

  it("a file that is not a database: operations fail with SW_HISTORY_CORRUPT", async () => {
    const s = createHistoryStore({ cwd: tmp.path, backend: "sqlite", captureGit: false });
    await s.ready();
    await s.close(); // release the cached connection before replacing the file
    await writeFile(path.join(histDir(), SQLITE_FILE), "this is not sqlite at all, just text ".repeat(200));
    for (const f of ["history.db-wal", "history.db-shm"])
      await unlink(path.join(histDir(), f)).catch(() => {});
    await expect(s.list()).rejects.toMatchObject({ code: "SW_HISTORY_CORRUPT" });
    const v = await s.verify();
    expect(v.ok).toBe(false);
    expect(v.errors[0]?.problem).toBe("db-integrity");
  });

  it("is lazy: createHistoryStore does not open (or create) the database until first use", async () => {
    const s = createHistoryStore({ cwd: tmp.path, backend: "sqlite", captureGit: false });
    await expect(readdir(histDir())).rejects.toThrow();
    expect(await s.list()).toEqual([]);
    expect(await readdir(histDir())).toContain(SQLITE_FILE);
  });
});

describe("SQLite store: verify finds damage", () => {
  it("checksum mismatch, missing report, unreadable record, baseline to a missing run", async () => {
    const s = await createSqliteStore({ cwd: tmp.path, isoNow: iso, captureGit: false });
    const a = await s.append({ results: [perfResult(1)] });
    const b = await s.append({ results: [perfResult(2)] });
    const c = await s.append({ results: [perfResult(3)] });
    expect((await s.verify()).ok).toBe(true);
    await withRawDb((db) => {
      const blob = (
        db.prepare("SELECT report FROM reports WHERE run_id = ?").get(a.id) as { report: Uint8Array }
      ).report;
      const bad = Buffer.from(blob);
      bad[bad.length - 5] = (bad[bad.length - 5] as number) ^ 0xff;
      db.prepare("UPDATE reports SET report = ? WHERE run_id = ?").run(bad, a.id);
      db.prepare("DELETE FROM reports WHERE run_id = ?").run(b.id);
      db.prepare("UPDATE runs SET entry = '{not json' WHERE id = ?").run(c.id);
      db.prepare("INSERT INTO baselines (name, run_id, set_at) VALUES ('ghost', '01GHOST', '')").run();
    });
    const v = await s.verify();
    expect(v.ok).toBe(false);
    expect(v.backend).toBe("sqlite");
    const problems = v.errors.map((e) => `${e.problem}:${e.id}`);
    expect(problems).toContain(`checksum-mismatch:${a.id}`);
    expect(problems).toContain(`missing-report:${b.id}`);
    expect(problems).toContain(`corrupt-index-line:${c.id}`);
    expect(problems).toContain("baseline-missing-run:01GHOST");
    // reads skip the unreadable record (with a warning) instead of failing
    const warnings: string[] = [];
    const again = await createSqliteStore({
      cwd: tmp.path,
      captureGit: false,
      onWarning: (m) => warnings.push(m),
    });
    expect((await again.list()).map((e) => e.id)).toEqual([b.id, a.id]);
    expect(await again.get(a.id)).toBeNull(); // corrupt report → null, like JSONL
    expect(warnings.join("\n")).toMatch(/unreadable run record/);
  });
});

describe("SQLite store: one-time JSONL import", () => {
  it("imports existing JSONL runs + baselines once, byte-identical, and keeps the JSONL files", async () => {
    const { jsonl, ids } = await seedJsonl(4);
    await jsonl.setBaseline("main", ids[1] as string);
    await jsonl.prune({ keepLast: 1 }); // ids[2] compacted (ids[0] has findings, ids[1] is baseline)
    const before = await jsonl.list();
    const indexBefore = await readFile(path.join(histDir(), "runs.jsonl"), "utf8");
    const warnings: string[] = [];
    const s = await createSqliteStore({
      cwd: tmp.path,
      captureGit: false,
      onWarning: (m) => warnings.push(m),
    });
    expect(await s.list()).toEqual(before);
    expect((await s.listBaselines()).map((b) => `${b.name}:${b.runId}`)).toEqual([`main:${ids[1]}`]);
    expect((await s.get(ids[3] as string))?.metrics["performance.http.p95"]).toBe(103);
    expect(await s.get(ids[2] as string)).toBeNull(); // compacted stays compacted
    expect((await s.verify()).ok).toBe(true);
    expect(warnings.filter((w) => /imported 4 run/.test(w)).length).toBe(1);
    expect(await readFile(path.join(histDir(), "runs.jsonl"), "utf8")).toBe(indexBefore);
    // reopen: nothing imported again
    const w2: string[] = [];
    const s2 = await createSqliteStore({ cwd: tmp.path, captureGit: false, onWarning: (m) => w2.push(m) });
    expect((await s2.list()).length).toBe(4);
    expect(w2).toEqual([]);
  });

  it("re-imports only new JSONL runs, never resurrects runs pruned in SQLite, skips torn lines", async () => {
    const { jsonl, ids } = await seedJsonl(3);
    const s = await createSqliteStore({ cwd: tmp.path, isoNow: iso, captureGit: false });
    expect((await s.list()).length).toBe(3);
    const removed = await s.prune({ keepLast: 1, compact: false });
    expect(removed.removed).toEqual([ids[1]]);
    // user goes back to JSONL for a while, records a run, and a torn line is left by a crash
    const extra = await jsonl.append({ results: [perfResult(500)] });
    await writeFile(
      path.join(histDir(), "runs.jsonl"),
      `${await readFile(path.join(histDir(), "runs.jsonl"), "utf8")}{"id":"torn`,
    );
    const warnings: string[] = [];
    const s2 = await createSqliteStore({
      cwd: tmp.path,
      captureGit: false,
      onWarning: (m) => warnings.push(m),
    });
    const now = (await s2.list()).map((e) => e.id);
    expect(now).toContain(extra.id);
    expect(now).not.toContain(ids[1]);
    expect(now.length).toBe(3);
    expect(warnings.join("\n")).toMatch(/1 unreadable line/);
  });

  it("a JSONL run whose report file is missing is imported and flagged by verify (same as JSONL)", async () => {
    const { ids } = await seedJsonl(2);
    await unlink(path.join(histDir(), "runs", `${ids[1]}.json.gz`));
    const s = await createSqliteStore({ cwd: tmp.path, captureGit: false });
    const v = await s.verify();
    expect(v.errors.map((e) => `${e.problem}:${e.id}`)).toEqual([`missing-report:${ids[1]}`]);
  });

  it("importJsonl: false leaves an existing JSONL history alone", async () => {
    await seedJsonl(2);
    const s = await createSqliteStore({ cwd: tmp.path, captureGit: false, importJsonl: false });
    expect(await s.list()).toEqual([]);
  });
});

describe("SQLite store: going back to JSONL", () => {
  it("exportSqliteHistoryToJsonl writes runs + baselines the JSONL index lacks (idempotent)", async () => {
    const { ids } = await seedJsonl(1);
    const s = await createSqliteStore({ cwd: tmp.path, isoNow: iso, captureGit: false });
    const a = await s.append({ results: [perfResult(7)] });
    const b = await s.append({ results: [perfResult(8)] });
    await s.setBaseline("sq", a.id);
    await s.prune({ keepLast: 1 }); // a is baseline, kept; nothing else compacted besides none
    expect(await exportSqliteHistoryToJsonl({ cwd: tmp.path })).toEqual({ exported: 2, baselines: 1 });
    expect(await exportSqliteHistoryToJsonl({ cwd: tmp.path })).toEqual({ exported: 0, baselines: 0 });
    const jsonl = createJsonlStore({ cwd: tmp.path, captureGit: false });
    expect((await jsonl.list()).map((e) => e.id)).toEqual([b.id, a.id, ids[0]]);
    expect((await jsonl.get(b.id))?.metrics["performance.http.p95"]).toBe(8);
    expect((await jsonl.getBaseline("sq"))?.id).toBe(a.id);
    expect((await jsonl.verify()).ok).toBe(true);
  });
});

describe("fallback when node:sqlite is unavailable", () => {
  it("createSqliteStore throws SqliteUnavailableError", async () => {
    await expect(createSqliteStore({ cwd: tmp.path, loadSqlite: async () => null })).rejects.toBeInstanceOf(
      SqliteUnavailableError,
    );
  });

  it("createHistoryStore falls back to JSONL with a warning and a fallbackReason", async () => {
    const warnings: string[] = [];
    const s = createHistoryStore({
      cwd: tmp.path,
      backend: "sqlite",
      captureGit: false,
      loadSqlite: async () => null,
      onWarning: (m) => warnings.push(m),
    });
    const e = await s.append({ results: [perfResult(1)] });
    expect(s.backend).toBe("jsonl");
    expect(s.fallbackReason).toMatch(/node:sqlite is not available.*JSONL/);
    expect(warnings).toEqual([s.fallbackReason]);
    expect((await createJsonlStore({ cwd: tmp.path }).list())[0]?.id).toBe(e.id);
  });
});

describe("plugin history backends (registry)", () => {
  it("a registered backend is used by createHistoryStore; names are validated and unique", async () => {
    const seen: unknown[] = [];
    const off = registerHistoryBackend("acme/mem", (o) => {
      seen.push(o.options);
      return { ...createJsonlStore({ cwd: o.cwd, dir: path.join(o.dir, "acme") }), backend: "acme/mem" };
    });
    try {
      expect(listHistoryBackends()).toContain("acme/mem");
      expect(() => registerHistoryBackend("acme/mem", () => createJsonlStore())).toThrow(
        /already registered/,
      );
      expect(() => registerHistoryBackend("sqlite", () => createJsonlStore())).toThrow(/built in/);
      expect(() => registerHistoryBackend("bad name", () => createJsonlStore())).toThrow(/Invalid/);
      const s = await openHistoryStore({
        cwd: tmp.path,
        backend: "acme/mem",
        options: { x: 1 },
        captureGit: false,
      });
      expect(s.backend).toBe("acme/mem");
      await s.append({ results: [perfResult(1)] });
      expect((await s.list()).length).toBe(1);
      expect(seen).toEqual([{ x: 1 }]);
    } finally {
      off();
    }
    expect(listHistoryBackends()).not.toContain("acme/mem");
    await expect(createHistoryStore({ cwd: tmp.path, backend: "acme/mem" }).list()).rejects.toMatchObject({
      code: "SW_HISTORY_BACKEND",
    });
  });
});

describe("node:sqlite warning filter", () => {
  it("matches only node:sqlite's own ExperimentalWarning", () => {
    const msg = "SQLite is an experimental feature and might change at any time";
    expect(isNodeSqliteWarning(msg, "ExperimentalWarning")).toBe(true);
    expect(isNodeSqliteWarning(msg, { type: "ExperimentalWarning" })).toBe(true);
    const err = Object.assign(new Error(msg), { name: "ExperimentalWarning" });
    expect(isNodeSqliteWarning(err)).toBe(true);
    expect(isNodeSqliteWarning(msg, "DeprecationWarning")).toBe(false);
    expect(isNodeSqliteWarning("VM Modules is an experimental feature", "ExperimentalWarning")).toBe(false);
    expect(isNodeSqliteWarning(msg)).toBe(false);
  });
});
