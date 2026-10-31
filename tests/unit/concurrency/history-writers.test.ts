/**
 * Concurrent writers and crash recovery for the JSONL history store (Plan wave 7 §A;
 * docs/03-engines/evidence-and-history.md §B.1–§B.3). In-process writers here; real processes in
 * tests/integration/concurrency/.
 */
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { createWorld } from "../../../src/core/world.js";
import { createHistoryStore } from "../../../src/engines/history/index.js";
import { writeFileAtomic } from "../../../src/engines/reporting/json.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir;
beforeEach(async () => {
  tmp = await makeTmpDir("sw-conc-");
});
afterEach(async () => {
  await tmp.cleanup();
});

let seq = 0;
function result(p95: number): EngineResult {
  const n = ++seq;
  return {
    schemaVersion: 1,
    engine: "performance",
    runId: `01JCONC${String(n).padStart(19, "0")}`,
    status: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    findings: [],
    limitations: [],
    artifacts: [],
    data: {
      latency: { corrected: { mean: p95 / 2, p50: p95 / 2, p90: p95, p95, p99: p95, max: p95 } },
      totals: { rps: 100, errorRate: 0, requests: 1000 },
      endpoints: [],
      // bulk so a record is far larger than one disk sector / pipe buffer
      pad: "x".repeat(20_000),
    },
  } as EngineResult;
}

async function indexLines(dir: string): Promise<string[]> {
  return (await readFile(path.join(dir, "runs.jsonl"), "utf8")).split("\n").filter((l) => l !== "");
}

describe("history: concurrent in-process writers", () => {
  it("8 parallel world.history.save → 8 records under their own runIds, no torn lines, verify ok", async () => {
    const world = await createWorld({
      cwd: tmp.path,
      probe: false,
      auditFile: false,
      userConfig: false,
      config: { history: { enabled: true } },
    });
    try {
      const rs = Array.from({ length: 8 }, (_, i) => result(100 + i));
      const saved = await Promise.all(rs.map((r) => world.history.save([r], { label: "conc" })));
      expect(saved.map((s) => s?.id).sort()).toEqual(rs.map((r) => r.runId).sort());
      const store = await world.history.store();
      const dir = (store as unknown as { dir: string }).dir;
      const lines = await indexLines(dir);
      expect(lines).toHaveLength(8);
      for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
      const v = await (
        store as unknown as { verify(): Promise<{ ok: boolean; warnings: unknown[] }> }
      ).verify();
      expect(v).toMatchObject({ ok: true, warnings: [] });
    } finally {
      await world.close();
    }
  });

  it("8 store instances × 4 appends + a concurrent reader: 32 unique records, reader never fails", async () => {
    const dir = tmp.join("h");
    const stores = Array.from({ length: 8 }, () => createHistoryStore({ dir, captureGit: false }));
    let writing = true;
    let reads = 0;
    let maxSeen = 0;
    const readerWarnings: string[] = [];
    const reader = (async () => {
      const r = createHistoryStore({ dir, captureGit: false, onWarning: (m) => readerWarnings.push(m) });
      while (writing) {
        const n = (await r.list()).length; // must never throw mid-append
        expect(n).toBeGreaterThanOrEqual(maxSeen); // records never disappear
        maxSeen = n;
        reads++;
        await new Promise((res) => setImmediate(res));
      }
    })();
    const entries = (
      await Promise.all(
        stores.map(async (s, i) => {
          const out = [];
          for (let k = 0; k < 4; k++) out.push(await s.append({ results: [result(10 * i + k)] }));
          return out;
        }),
      )
    ).flat();
    writing = false;
    await reader;
    expect(reads).toBeGreaterThan(0);
    // one write() per record: a reader never observes half a record
    expect(readerWarnings).toEqual([]);
    expect(new Set(entries.map((e) => e.id)).size).toBe(32);
    const lines = await indexLines(dir);
    expect(lines).toHaveLength(32);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    const v = await stores[0]!.verify();
    expect(v).toMatchObject({ ok: true, checked: 32, warnings: [] });
    expect((await readdir(dir)).sort()).toEqual(["runs", "runs.jsonl"]); // no lock / temp left
  });

  it("8 parallel setBaseline from separate instances: no lost update", async () => {
    const dir = tmp.join("h");
    const s0 = createHistoryStore({ dir, captureGit: false });
    const e = await s0.append({ results: [result(1)] });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createHistoryStore({ dir, captureGit: false }).setBaseline(`b${i}`, e.id),
      ),
    );
    expect((await s0.listBaselines()).map((b) => b.name)).toEqual([
      "b0",
      "b1",
      "b2",
      "b3",
      "b4",
      "b5",
      "b6",
      "b7",
    ]);
  });
});

describe("history: crash consistency", () => {
  it("a record cut off mid-append is skipped with a warning; the next append and reads work", async () => {
    const dir = tmp.join("h");
    const warnings: string[] = [];
    const store = createHistoryStore({ dir, captureGit: false, onWarning: (m) => warnings.push(m) });
    const a = await store.append({ results: [result(1)] });
    const full = (await indexLines(dir))[0] as string;
    // simulate a writer killed mid-write: half a record, no newline; plus a leftover temp body
    await appendFile(
      path.join(dir, "runs.jsonl"),
      full.slice(0, full.length / 2).replace(a.id, "01JPARTIAL0000000000000000"),
    );
    await writeFile(path.join(dir, "runs", "01JPARTIAL.json.gz.tmp-999-abcd"), "garbage");

    expect((await store.list()).map((e) => e.id)).toEqual([a.id]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/skipped 1 unreadable line\(s\) \(line 2\); the last record is incomplete/);
    await store.list(); // same problem is reported once per store
    expect(warnings).toHaveLength(1);

    const b = await store.append({ results: [result(2)] });
    expect((await store.list()).map((e) => e.id)).toEqual([b.id, a.id]);
    expect(await store.get(b.id)).not.toBeNull();
    const v = await store.verify();
    expect(v.errors.map((x) => x.problem)).toEqual(["corrupt-index-line"]);
    expect(v.warnings.map((x) => x.problem)).toEqual(["leftover-temp"]);
  });

  it("a torn index without a warning hook still reads (library default)", async () => {
    const dir = tmp.join("h");
    const store = createHistoryStore({ dir, captureGit: false });
    await store.append({ results: [result(1)] });
    await appendFile(path.join(dir, "runs.jsonl"), '{"v":1,"id":"01J');
    expect(await store.list()).toHaveLength(1);
  });
});

describe("report files: concurrent atomic writes", () => {
  it("8 writers to the same report file → one complete version, no temp files", async () => {
    const file = tmp.join("out", "report.json");
    const bodies = Array.from(
      { length: 8 },
      (_, i) => `${JSON.stringify({ writer: i, pad: "y".repeat(200_000) })}\n`,
    );
    for (let round = 0; round < 5; round++) {
      await Promise.all(bodies.map((b) => writeFileAtomic(file, b)));
      expect(bodies).toContain(await readFile(file, "utf8"));
    }
    expect(await readdir(path.dirname(file))).toEqual(["report.json"]);
  });
});
