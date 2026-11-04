/**
 * Shared HistoryStore contract suite (docs/03-engines/evidence-and-history.md Part B; CONTRACTS.md
 * "sw-sqlite-w9"). Runs against every backend — JSONL, SQLite, and plugin stores:
 *
 *   describeHistoryStoreContract("my-store", ({ cwd, isoNow }) => createMyStore({ cwd, isoNow }));
 *
 * Only observable behaviour is asserted (no file layout), so a plugin store can reuse it as is.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { createFinding } from "../../../src/core/evidence/store.js";
import type { HistoryStore } from "../../../src/engines/history/index.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

/** Shortest prefix of `id` (at least `min` chars) that no id in `others` starts with. */
function uniquePrefix(id: string, others: readonly string[], min = 6): string {
  for (let n = min; n < id.length; n++) {
    const p = id.slice(0, n);
    if (!others.some((o) => o.startsWith(p))) return p;
  }
  return id;
}

export interface ContractStoreOptions {
  cwd: string;
  isoNow: () => string;
}

export type MakeStore = (o: ContractStoreOptions) => HistoryStore | Promise<HistoryStore>;

let seq = 0;

/** A minimal performance EngineResult with a p95 and optional findings / endpoints. */
export function perfResult(
  p95: number,
  findings: { title: string; ruleId?: string }[] = [],
  endpoints: { key: string; p95: number }[] = [],
): EngineResult {
  return {
    schemaVersion: 1,
    engine: "performance",
    runId: `r${++seq}`,
    status: findings.length ? "failed" : "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    findings: findings.map((f) =>
      createFinding({
        engine: "performance",
        ruleId: f.ruleId ?? "PERF-THRESHOLD",
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
      endpoints: endpoints.map((e) => ({
        key: e.key,
        latency: { corrected: { p50: e.p95 / 2, p95: e.p95, p99: e.p95 * 1.2 } },
        requests: 10,
        errorRate: 0,
      })),
    },
  } as unknown as EngineResult;
}

export function stressResult(): EngineResult {
  return { ...perfResult(50), engine: "stress", data: {} } as unknown as EngineResult;
}

/** Deterministic clock: +1 s per call from 2026-01-01. */
export function makeClock(): () => string {
  let ms = Date.UTC(2026, 0, 1);
  return () => {
    ms += 1000;
    return new Date(ms).toISOString();
  };
}

export function describeHistoryStoreContract(name: string, make: MakeStore): void {
  describe(`HistoryStore contract: ${name}`, () => {
    let tmp: TmpDir;
    let isoNow: () => string;
    let store: HistoryStore;
    beforeEach(async () => {
      tmp = await makeTmpDir("sw-hist-contract-");
      isoNow = makeClock();
      store = await make({ cwd: tmp.path, isoNow });
    });
    afterEach(async () => {
      await (store as HistoryStore & { close?: () => Promise<void> }).close?.();
      await tmp.cleanup();
    });

    it("append / get / list / query / prefix ids / baselines / reopen", async () => {
      const a = await store.append({ results: [perfResult(100)], label: "first", tags: ["ci"], git: false });
      const b = await store.append({ results: [perfResult(120, [{ title: "p95 breached" }])], git: false });
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.bytes).toBeGreaterThan(0);
      expect(a.metrics["performance.http.p95"]).toBe(100);
      expect(a.findings).toEqual({ count: 0, maxSeverity: null, fingerprints: [] });
      expect(b.findings.count).toBe(1);
      expect(b.findings.maxSeverity).toBe("high");
      expect((await store.list()).map((e) => e.id)).toEqual([b.id, a.id]);
      expect((await store.list({ limit: 1 }))[0]?.id).toBe(b.id);
      const run = await store.get(a.id);
      expect(run?.schemaVersion).toBe(1);
      expect(run?.label).toBe("first");
      expect(run?.tags).toEqual(["ci"]);
      expect(run?.results[0]?.engine).toBe("performance");
      // Run ids are monotonic ULIDs: two runs made in the same millisecond share their first ~20 chars,
      // so pick the shortest prefix (>= 6) that is unique, as `sw history show <prefix>` users do.
      const bp = uniquePrefix(b.id, [a.id]);
      expect((await store.get(bp))?.id).toBe(b.id);
      expect((await store.get(bp.toLowerCase()))?.id).toBe(b.id);
      expect(await store.get("01NOPE0000000000000000000")).toBeNull();
      expect(await store.get(b.id.slice(0, 5))).toBeNull(); // prefix < 6 chars
      expect((await store.query({ hasFindings: true })).map((e) => e.id)).toEqual([b.id]);
      expect((await store.query({ hasFindings: false })).map((e) => e.id)).toEqual([a.id]);
      expect((await store.query({ tag: "ci" })).map((e) => e.id)).toEqual([a.id]);
      expect((await store.query({ label: "first" })).map((e) => e.id)).toEqual([a.id]);
      expect((await store.query((e) => e.metrics["performance.http.p95"] === 120)).map((e) => e.id)).toEqual([
        b.id,
      ]);
      await store.setBaseline("main", a.id);
      expect((await store.getBaseline("main"))?.id).toBe(a.id);
      expect((await store.get("baseline:main"))?.id).toBe(a.id);
      expect(await store.get("baseline:nope")).toBeNull();
      expect(await store.getBaseline("nope")).toBeNull();
      expect((await store.listBaselines()).map((x) => x.name)).toEqual(["main"]);
      const v = await store.verify();
      expect(v).toMatchObject({ ok: true, checked: 2, errors: [] });
      const again = await make({ cwd: tmp.path, isoNow });
      expect((await again.list()).map((e) => e.id)).toEqual([b.id, a.id]);
      expect((await again.listBaselines())[0]?.runId).toBe(a.id);
    });

    it("orders by createdAt then id; filters engine / status / since / until / fingerprint / branch", async () => {
      const t = "2026-02-01T00:00:00.000Z";
      const x = await store.append({
        results: [perfResult(1)],
        id: "01B00000000000000000000000",
        createdAt: t,
        git: false,
      });
      const y = await store.append({
        results: [perfResult(2)],
        id: "01A00000000000000000000000",
        createdAt: t,
        git: false,
      });
      const z = await store.append({
        results: [stressResult(), perfResult(3, [{ title: "slow" }])],
        createdAt: "2026-03-01T00:00:00.000Z",
        git: { commit: "abc", branch: "feature/x", dirty: false },
      });
      expect((await store.list()).map((e) => e.id)).toEqual([z.id, x.id, y.id]);
      expect((await store.list({ engine: "stress" })).map((e) => e.id)).toEqual([z.id]);
      expect((await store.list({ branch: "feature/x" })).map((e) => e.id)).toEqual([z.id]);
      expect(await store.list({ branch: "main" })).toEqual([]);
      expect((await store.query({ status: "failed" })).map((e) => e.id)).toEqual([z.id]);
      expect((await store.query({ since: "2026-02-15T00:00:00.000Z" })).map((e) => e.id)).toEqual([z.id]);
      expect((await store.query({ until: t })).map((e) => e.id)).toEqual([x.id, y.id]);
      const fp = z.findings.fingerprints[0] as string;
      expect((await store.query({ fingerprint: fp })).map((e) => e.id)).toEqual([z.id]);
      expect((await store.query({ limit: 2 })).map((e) => e.id)).toEqual([z.id, x.id]);
      expect(z.engines.sort()).toEqual(["performance", "stress"]);
      expect(z.git).toEqual({ commit: "abc", branch: "feature/x", dirty: false });
      expect((await store.get(z.id))?.git?.branch).toBe("feature/x");
    });

    it("explicit id: same id again replaces the run (last wins); invalid ids are rejected", async () => {
      const id = "01EXPLICIT0000000000000000";
      await store.append({ results: [perfResult(10)], id, git: false });
      await store.append({ results: [perfResult(20)], id, label: "second", git: false });
      const all = await store.list();
      expect(all.map((e) => e.id)).toEqual([id]);
      expect(all[0]?.label).toBe("second");
      expect((await store.get(id))?.metrics["performance.http.p95"]).toBe(20);
      for (const bad of ["../evil", ".hidden", "a b", ""])
        await expect(store.append({ results: [perfResult(1)], id: bad, git: false })).rejects.toMatchObject({
          code: "SW_HISTORY_BAD_ID",
        });
    });

    it("ambiguous prefix throws; metrics/repetitions/meta round-trip", async () => {
      await store.append({ results: [perfResult(1)], id: "01AMBIG00000000000000000A1", git: false });
      await store.append({
        results: [perfResult(2)],
        id: "01AMBIG00000000000000000B2",
        metrics: { "custom.score": 7 },
        repetitions: { "performance.http.p95": [1, 2, 3] },
        meta: { cmd: "perf" },
        git: false,
      });
      await expect(store.get("01AMBIG")).rejects.toMatchObject({ code: "SW_HISTORY_AMBIGUOUS" });
      const r = await store.get("01AMBIG00000000000000000B");
      expect(r?.metrics["custom.score"]).toBe(7);
      expect(r?.metrics["performance.http.p95"]).toBe(2);
      expect(r?.repetitions).toEqual({ "performance.http.p95": [1, 2, 3] });
      expect(r?.meta).toEqual({ cmd: "perf" });
    });

    it("baselines: invalid name, unknown run, overwrite, sorted list", async () => {
      const a = await store.append({ results: [perfResult(1)], git: false });
      const b = await store.append({ results: [perfResult(2)], git: false });
      await expect(store.setBaseline("bad name!", a.id)).rejects.toThrow(/Invalid baseline name/);
      await expect(store.setBaseline("x", "01UNKNOWN0000000000000000")).rejects.toMatchObject({
        code: "SW_HISTORY_NOT_FOUND",
      });
      const ref = await store.setBaseline("zeta", a.id);
      expect(ref).toMatchObject({ name: "zeta", runId: a.id });
      expect(typeof ref.setAt).toBe("string");
      await store.setBaseline("alpha", uniquePrefix(a.id, [b.id], 10));
      await store.setBaseline("alpha", b.id);
      expect((await store.listBaselines()).map((x) => `${x.name}:${x.runId}`)).toEqual([
        `alpha:${b.id}`,
        `zeta:${a.id}`,
      ]);
    });

    it("diff: single-run comparison and new / fixed / regressed findings", async () => {
      const old = await store.append({
        results: [perfResult(100, [{ title: "flaky", ruleId: "PERF-OLD" }])],
        git: false,
      });
      const base = await store.append({ results: [perfResult(100, [{ title: "gone" }])], git: false });
      const cur = await store.append({
        results: [perfResult(150, [{ title: "flaky", ruleId: "PERF-OLD" }])],
        git: false,
      });
      await store.setBaseline("main", base.id);
      const d = await store.diff("baseline:main", cur.id);
      expect(d.method).toBe("single-run");
      expect(d.baselineIds).toEqual([base.id]);
      expect(d.currentIds).toEqual([cur.id]);
      expect(d.findings.fixed.length).toBe(1);
      expect(d.findings.regressed.length).toBe(1); // seen in `old`, before the baseline
      expect(d.findings.new.length).toBe(0);
      const p95 = d.metrics.find((m) => m.metric === "performance.http.p95");
      expect(p95?.movement).toBe("worse");
      await expect(store.diff("01MISSING000000000000", cur.id)).rejects.toMatchObject({
        code: "SW_HISTORY_NOT_FOUND",
      });
      expect(old.id).not.toBe(cur.id);
    });

    it("trend: default metric name, limit, endpoint resolution, filters", async () => {
      for (const v of [100, 101, 99, 100, 102, 300])
        await store.append({ results: [perfResult(v, [], [{ key: "GET /users", p95: v / 2 }])], git: false });
      await store.append({ results: [stressResult()], git: false }); // no performance metric
      const t = await store.trend("p95");
      expect(t.metric).toBe("performance.http.p95");
      expect(t.points.map((p) => p.value)).toEqual([100, 101, 99, 100, 102, 300]);
      expect((await store.trend("p95", { limit: 2 })).points.map((p) => p.value)).toEqual([102, 300]);
      expect((await store.trend("performance.http.p95", { engine: "stress" })).points).toEqual([]);
      const ep = await store.trend("p95", { endpoint: "/users" });
      expect(ep.metric).toBe("performance.endpoint.GET /users.p95");
      expect(ep.points.map((p) => p.value)).toEqual([50, 50.5, 49.5, 50, 51, 150]);
      const missing = await store.trend("p95", { endpoint: "/nope" });
      expect(missing.metric).toBe("performance.endpoint./nope.p95");
      expect(missing.points).toEqual([]);
    });

    it("trend endpoint: the first endpoint seen wins when several match; hard prune re-resolves", async () => {
      const first = await store.append({
        results: [perfResult(1, [], [{ key: "POST /items", p95: 9 }])],
        git: false,
      });
      for (let i = 0; i < 3; i++)
        await store.append({
          results: [
            perfResult(
              1,
              [],
              [
                { key: "GET /items", p95: i },
                { key: "POST /items", p95: 7 },
              ],
            ),
          ],
          git: false,
        });
      expect((await store.trend("p95", { endpoint: "/items" })).metric).toBe(
        "performance.endpoint.POST /items.p95",
      );
      // an older run appended later (explicit createdAt) becomes the first appearance
      await store.append({
        results: [perfResult(1, [], [{ key: "GET /items", p95: 5 }])],
        createdAt: "2000-01-01T00:00:00.000Z",
        git: false,
      });
      expect((await store.trend("p95", { endpoint: "/items" })).metric).toBe(
        "performance.endpoint.GET /items.p95",
      );
      await store.prune({ keepLast: 3, compact: false }); // removes the 2000 run and `first`
      expect((await store.list()).map((e) => e.id)).not.toContain(first.id);
      expect((await store.trend("p95", { endpoint: "/items" })).metric).toBe(
        "performance.endpoint.GET /items.p95",
      );
      // same id appended again with other metrics: names follow the replacement
      const last = (await store.list())[0]?.id as string;
      await store.append({
        id: last,
        results: [perfResult(1, [], [{ key: "PUT /items", p95: 1 }])],
        git: false,
      });
      const t50 = await store.trend("p50", { endpoint: "/items" });
      expect(t50.metric).toBe("performance.endpoint.GET /items.p50");
      expect(t50.points.length).toBe(2); // the replaced run only has PUT /items now
      expect((await store.trend("p50", { endpoint: "PUT /items" })).points.length).toBe(1);
    });

    it("prune: dry-run, compaction keeps summaries for trends, hard removal, verify stays ok", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 8; i++)
        ids.push(
          (
            await store.append({
              results: [perfResult(100 + i, i === 1 ? [{ title: "breach" }] : [])],
              git: false,
            })
          ).id,
        );
      await store.setBaseline("main", ids[0] as string);
      const dry = await store.prune({ keepLast: 3, dryRun: true });
      expect(dry).toMatchObject({ dryRun: true, kept: 5 });
      expect(dry.compacted.length).toBe(3);
      expect((await store.list()).every((e) => !e.compacted)).toBe(true);
      const r = await store.prune({ keepLast: 3 });
      expect([...r.compacted].sort()).toEqual([ids[2], ids[3], ids[4]].sort());
      expect(await store.get(ids[0] as string)).not.toBeNull();
      expect(await store.get(ids[1] as string)).not.toBeNull();
      expect(await store.get(ids[2] as string)).toBeNull();
      expect(
        (await store.list())
          .filter((e) => e.compacted)
          .map((e) => e.id)
          .sort(),
      ).toEqual([ids[2], ids[3], ids[4]].sort());
      expect((await store.list({ includeCompacted: false })).length).toBe(5);
      await expect(store.setBaseline("c", ids[2] as string)).rejects.toMatchObject({
        code: "SW_HISTORY_COMPACTED",
      });
      expect((await store.trend("p95")).points.length).toBe(8);
      expect((await store.verify()).ok).toBe(true);
      expect((await store.prune({ keepLast: 3 })).compacted).toEqual([]); // idempotent
      const hard = await store.prune({ keepLast: 3, compact: false });
      expect(hard.removed.length).toBe(3);
      expect((await store.list()).length).toBe(5);
      expect((await store.trend("p95")).points.length).toBe(5);
      expect((await store.verify()).ok).toBe(true);
    });

    it("an empty store lists, trends, verifies and prunes without error", async () => {
      expect(await store.list()).toEqual([]);
      expect(await store.query({})).toEqual([]);
      expect(await store.listBaselines()).toEqual([]);
      expect((await store.trend("p95")).points).toEqual([]);
      expect(await store.verify()).toMatchObject({ ok: true, checked: 0, errors: [] });
      expect(await store.prune()).toMatchObject({ kept: 0, compacted: [], removed: [] });
    });
  });
}
