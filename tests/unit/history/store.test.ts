import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { createFinding } from "../../../src/core/evidence/store.js";
import {
  acquireLock,
  atomicWrite,
  createHistoryStore,
  type HistoryStore,
  LockTimeoutError,
} from "../../../src/engines/history/index.js";
import { sha256 } from "../../../src/shared/util/hash.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir;
let store: HistoryStore;
let seq = 0;
let clockMs = Date.UTC(2026, 0, 1);

const iso = (): string => {
  clockMs += 1000;
  return new Date(clockMs).toISOString();
};

function perfResult(p95: number, findings: { title: string }[] = []): EngineResult {
  return {
    schemaVersion: 1,
    engine: "performance",
    runId: `r${++seq}`,
    status: findings.length ? "failed" : "passed",
    startedAt: iso(),
    endedAt: iso(),
    findings: findings.map((f) =>
      createFinding({
        engine: "performance",
        ruleId: "PERF-THRESHOLD",
        category: "performance",
        title: f.title,
        severity: "high",
        classification: "threshold-breach",
        confidence: 0.9,
        evidence: [{ kind: "note", text: "x" }],
      }),
    ),
    limitations: [],
    artifacts: [],
    data: {
      latency: {
        corrected: { mean: p95 / 2, p50: p95 / 2, p90: p95 * 0.9, p95, p99: p95 * 1.3, max: p95 * 2 },
      },
      totals: { rps: 100, errorRate: 0, requests: 1000 },
      endpoints: [],
    },
  };
}

beforeEach(async () => {
  tmp = await makeTmpDir("sw-hist-");
  store = createHistoryStore({ cwd: tmp.path, captureGit: false, isoNow: iso });
});
afterEach(async () => {
  await tmp.cleanup();
});

describe("history store (JSONL)", () => {
  it("append / get / list / query / prefix ids / baselines", async () => {
    const a = await store.append({ results: [perfResult(100)], label: "first", tags: ["ci"] });
    const b = await store.append({ results: [perfResult(120, [{ title: "p95 breached" }])] });
    expect(a.file).toBe(`runs/${a.id}.json.gz`);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.metrics["performance.http.p95"]).toBe(100);
    const list = await store.list();
    expect(list.map((e) => e.id)).toEqual([b.id, a.id]); // newest first
    expect((await store.list({ limit: 1 }))[0]?.id).toBe(b.id);
    const run = await store.get(a.id);
    expect(run?.label).toBe("first");
    expect(run?.results[0]?.engine).toBe("performance");
    expect((await store.get(b.id.slice(0, 20)))?.id).toBe(b.id);
    expect(await store.get("01NOPE0000000000000000000")).toBeNull();
    expect((await store.query({ hasFindings: true })).map((e) => e.id)).toEqual([b.id]);
    expect((await store.query({ tag: "ci" })).map((e) => e.id)).toEqual([a.id]);
    expect((await store.query((e) => e.metrics["performance.http.p95"] === 120)).length).toBe(1);
    expect(b.findings.count).toBe(1);
    expect(b.findings.maxSeverity).toBe("high");
    await store.setBaseline("main", a.id);
    expect((await store.getBaseline("main"))?.id).toBe(a.id);
    expect(await store.getBaseline("nope")).toBeNull();
    expect((await store.listBaselines()).map((x) => x.name)).toEqual(["main"]);
    // reopen: everything persisted
    const again = createHistoryStore({ cwd: tmp.path, captureGit: false });
    expect((await again.list()).length).toBe(2);
    expect((await again.verify()).ok).toBe(true);
  });

  it("survives a simulated crash: leftover .tmp and truncated index line are ignored", async () => {
    const a = await store.append({ results: [perfResult(100)] });
    const runsDir = path.join(store.dir, "runs");
    await writeFile(path.join(runsDir, `01CRASH.json.gz.tmp-999-abcd`), "partial");
    await writeFile(
      path.join(store.dir, "runs.jsonl"),
      `${await readFile(path.join(store.dir, "runs.jsonl"), "utf8")}{"v":1,"id":"01TRUNC`,
    );
    const list = await store.list();
    expect(list.map((e) => e.id)).toEqual([a.id]);
    expect((await store.get(a.id))?.id).toBe(a.id);
    const v = await store.verify();
    expect(v.warnings.some((w) => w.problem === "leftover-temp")).toBe(true);
    expect(v.errors.map((e) => e.problem)).toEqual(["corrupt-index-line"]);
    // later appends still work and land on their own line
    const b = await store.append({ results: [perfResult(101)] });
    expect((await store.list()).map((e) => e.id)).toContain(b.id);
    // prune cleans temp files
    await store.prune({ keepLast: 10 });
    expect((await readdir(runsDir)).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("atomicWrite replaces the target completely and leaves no temp files", async () => {
    const f = tmp.join("x", "file.json");
    await atomicWrite(f, "one");
    await atomicWrite(f, "two");
    expect(await readFile(f, "utf8")).toBe("two");
    expect(await readdir(path.dirname(f))).toEqual(["file.json"]);
  });

  it("lock contention: two concurrent writers (separate store instances) interleave safely", async () => {
    const s2 = createHistoryStore({ cwd: tmp.path, captureGit: false });
    const N = 15;
    await Promise.all([
      ...Array.from({ length: N }, (_, i) => store.append({ results: [perfResult(100 + i)] })),
      ...Array.from({ length: N }, (_, i) => s2.append({ results: [perfResult(200 + i)] })),
    ]);
    expect((await store.list()).length).toBe(2 * N);
    const v = await store.verify();
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([]);
    const lines = (await readFile(path.join(store.dir, "runs.jsonl"), "utf8")).trim().split("\n");
    expect(lines.length).toBe(2 * N);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("lock: a live holder blocks until released; timeout raises LockTimeoutError", async () => {
    const lock = tmp.join("h", ".lock");
    const release = await acquireLock(lock);
    await expect(acquireLock(lock, { timeoutMs: 150 })).rejects.toBeInstanceOf(LockTimeoutError);
    const waiter = acquireLock(lock, { timeoutMs: 5000 });
    setTimeout(() => void release(), 100);
    const r2 = await waiter;
    await r2();
  });

  it("lock: stale locks (old timestamp or dead pid) are broken", async () => {
    const lock = tmp.join("h", ".lock");
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(
      lock,
      JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() - 3_600_000, token: "old" }),
    );
    const r = await acquireLock(lock, { timeoutMs: 1000, staleMs: 60_000 });
    await r();
    // dead pid on this host (pid 2^22+ is practically never alive)
    await writeFile(
      lock,
      JSON.stringify({ pid: 4_194_000, host: hostname(), at: Date.now(), token: "dead" }),
    );
    const r3 = await acquireLock(lock, { timeoutMs: 1000 });
    await r3();
  });

  it("verify detects corruption: checksum mismatch, missing report, baseline to missing run", async () => {
    const a = await store.append({ results: [perfResult(100)] });
    const b = await store.append({ results: [perfResult(110)] });
    const fa = path.join(store.dir, a.file);
    const buf = await readFile(fa);
    buf[buf.length - 5] = (buf[buf.length - 5] as number) ^ 0xff;
    await writeFile(fa, buf);
    const { unlink } = await import("node:fs/promises");
    await unlink(path.join(store.dir, b.file));
    await writeFile(
      path.join(store.dir, "baselines.json"),
      JSON.stringify({ x: { name: "x", runId: "01GHOST", setAt: "" } }),
    );
    const v = await store.verify();
    expect(v.ok).toBe(false);
    const problems = v.errors.map((e) => `${e.problem}:${e.id}`);
    expect(problems).toContain(`checksum-mismatch:${a.id}`);
    expect(problems).toContain(`missing-report:${b.id}`);
    expect(problems).toContain("baseline-missing-run:01GHOST");
  });

  it("prune keeps last N + baselines + runs with findings; compacts the rest (summary stays for trends)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const e = await store.append({ results: [perfResult(100 + i, i === 1 ? [{ title: "breach" }] : [])] });
      ids.push(e.id);
    }
    await store.setBaseline("main", ids[0]!);
    const dry = await store.prune({ keepLast: 3, dryRun: true });
    expect(dry.compacted.length).toBe(3);
    expect((await store.list()).every((e) => !e.compacted)).toBe(true);
    const r = await store.prune({ keepLast: 3 });
    expect(r.compacted.sort()).toEqual([ids[2], ids[3], ids[4]].sort());
    expect(await store.get(ids[0]!)).not.toBeNull(); // baseline
    expect(await store.get(ids[1]!)).not.toBeNull(); // has findings
    expect(await store.get(ids[2]!)).toBeNull(); // compacted
    expect(await store.get(ids[7]!)).not.toBeNull(); // last N
    const t = await store.trend("p95");
    expect(t.points.length).toBe(8);
    expect((await store.verify()).ok).toBe(true);
    const hard = await store.prune({ keepLast: 3, compact: false });
    expect(hard.removed.length).toBe(3);
    expect((await store.list()).length).toBe(5);
  });

  it("migrates a legacy v0 report (bare EngineResult[]) on read without rewriting it", async () => {
    const id = "01LEGACY000000000000000000";
    const gz = gzipSync(Buffer.from(JSON.stringify([perfResult(77)])));
    await mkdir(path.join(store.dir, "runs"), { recursive: true });
    await writeFile(path.join(store.dir, "runs", `${id}.json.gz`), gz);
    const entry = {
      v: 1,
      id,
      createdAt: "2025-01-01T00:00:00.000Z",
      tags: [],
      engines: ["performance"],
      status: "passed",
      metrics: {},
      findings: { count: 0, maxSeverity: null, fingerprints: [] },
      file: `runs/${id}.json.gz`,
      sha256: sha256(gz),
      bytes: gz.length,
    };
    await writeFile(path.join(store.dir, "runs.jsonl"), `${JSON.stringify(entry)}\n`);
    const run = await store.get(id);
    expect(run?.schemaVersion).toBe(1);
    expect(run?.metrics["performance.http.p95"]).toBe(77);
    expect(run?.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(sha256(await readFile(path.join(store.dir, "runs", `${id}.json.gz`)))).toBe(entry.sha256);
    expect((await store.verify()).ok).toBe(true);
  });

  it("sqlite backend request falls back to JSONL with a reason", () => {
    const s = createHistoryStore({ cwd: tmp.path, backend: "sqlite", captureGit: false });
    expect(s.backend).toBe("jsonl");
    expect(s.fallbackReason).toMatch(/sqlite/);
  });
});
