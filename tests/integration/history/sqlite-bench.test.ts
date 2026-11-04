/**
 * History backend benchmark at 10,000 runs (docs/03-engines/evidence-and-history.md §B.1 numbers).
 * Opt-in (slow): SW_BENCH=1 npx vitest run tests/integration/history/sqlite-bench.test.ts
 * Optional SW_BENCH_RUNS (default 10000). Prints a table; asserts only that both backends agree.
 */
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createJsonlStore, type HistoryStore } from "../../../src/engines/history/index.js";
import { createSqliteStore } from "../../../src/engines/history/sqlite-store.js";
import { makeTmpDir } from "../../helpers/tmp.js";
import { makeClock, perfResult } from "../../unit/history/contract.js";

const RUNS = Number(process.env.SW_BENCH_RUNS ?? 10_000);

async function time<T>(fn: () => Promise<T>, reps = 5): Promise<{ ms: number; value: T }> {
  let best = Number.POSITIVE_INFINITY;
  let value: T | undefined;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    value = await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, value: value as T };
}

describe.skipIf(process.env.SW_BENCH !== "1")("history benchmark", () => {
  it(`list / trend / show / append at ${RUNS} runs: JSONL vs SQLite`, { timeout: 1_800_000 }, async () => {
    const tmp = await makeTmpDir("sw-hist-bench-");
    try {
      const iso = makeClock();
      const jsonl = createJsonlStore({ cwd: tmp.path, isoNow: iso, captureGit: false });
      const endpoints = [
        { key: "GET /users", p95: 20 },
        { key: "POST /orders", p95: 40 },
        { key: "GET /orders/{id}", p95: 15 },
      ];
      const t0 = performance.now();
      for (let i = 0; i < RUNS; i++)
        await jsonl.append({
          results: [perfResult(100 + (i % 17), i % 50 === 0 ? [{ title: `f${i % 3}` }] : [], endpoints)],
          label: i % 2 ? "nightly" : "pr",
        });
      const seedMs = performance.now() - t0;
      const t1 = performance.now();
      const sqlite = await createSqliteStore({ cwd: tmp.path, isoNow: iso, captureGit: false });
      const importMs = performance.now() - t1;

      const rows: string[] = [];
      const ids = (await jsonl.list({ limit: 1 })).map((e) => e.id);
      const mid = (await jsonl.list())[Math.floor(RUNS / 2)]?.id as string;
      const bench = async (name: string, op: (s: HistoryStore) => Promise<unknown>) => {
        const a = await time(() => op(jsonl));
        const b = await time(() => op(sqlite));
        expect(JSON.stringify(b.value)).toBe(JSON.stringify(a.value));
        rows.push(`| ${name} | ${a.ms.toFixed(1)} | ${b.ms.toFixed(1)} |`);
      };
      await bench("list (default 20)", (s) => s.list({ limit: 20 }));
      await bench("list (all)", (s) => s.list());
      await bench("list --label nightly --limit 20", (s) => s.list({ label: "nightly", limit: 20 }));
      await bench("trend p95 (all runs)", (s) => s.trend("p95"));
      await bench("trend p95 --limit 50", (s) => s.trend("p95", { limit: 50 }));
      await bench("trend endpoint p95", (s) => s.trend("p95", { endpoint: "/users" }));
      await bench("show <newest id>", (s) => s.get(ids[0] as string));
      await bench("show <prefix of a middle run>", (s) => s.get(mid.slice(0, 16)));
      await bench("verify", async (s) => {
        const v = await s.verify();
        return { ok: v.ok, checked: v.checked };
      });
      // Cold: a fresh store per call (what one `sw history list` process pays, minus Node startup).
      {
        const a = await time(() =>
          createJsonlStore({ cwd: tmp.path, captureGit: false }).list({ limit: 20 }),
        );
        const b = await time(async () => {
          const s = await createSqliteStore({ cwd: tmp.path, captureGit: false });
          const r = await s.list({ limit: 20 });
          await s.close();
          return r;
        });
        expect(JSON.stringify(b.value)).toBe(JSON.stringify(a.value));
        rows.push(`| cold: open store + list 20 | ${a.ms.toFixed(1)} | ${b.ms.toFixed(1)} |`);
      }
      const appendTime = async (s: HistoryStore) => {
        const t = performance.now();
        for (let i = 0; i < 50; i++) await s.append({ results: [perfResult(100, [], endpoints)] });
        return (performance.now() - t) / 50;
      };
      const aj = await appendTime(jsonl);
      const as = await appendTime(sqlite);
      rows.push(`| append (mean of 50) | ${aj.toFixed(1)} | ${as.toFixed(1)} |`);
      const { statSync } = await import("node:fs");
      const path = await import("node:path");
      const dbBytes = statSync(path.join(sqlite.dir, "history.db")).size;
      const idxBytes = statSync(path.join(jsonl.dir, "runs.jsonl")).size;
      process.stdout.write(
        [
          "",
          `history benchmark: ${RUNS} runs, Node ${process.version}, ${process.platform}`,
          `seed (JSONL appends): ${(seedMs / 1000).toFixed(1)} s; one-time JSONL→SQLite import: ${(importMs / 1000).toFixed(2)} s`,
          `runs.jsonl ${(idxBytes / 1e6).toFixed(1)} MB (+ report files); history.db ${(dbBytes / 1e6).toFixed(1)} MB`,
          "| operation (best of 5, ms) | JSONL | SQLite |",
          "|---|---|---|",
          ...rows,
          "",
        ].join("\n"),
      );
    } finally {
      await tmp.cleanup();
    }
  });
});
