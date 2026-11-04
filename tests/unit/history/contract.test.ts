/**
 * One HistoryStore contract suite, run against BOTH built-in backends (JSONL and SQLite), plus a
 * parity check: the same operations produce identical index entries (same ids, metrics, sha256).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { createJsonlStore, type HistoryStore, openHistoryStore } from "../../../src/engines/history/index.js";
import { createSqliteStore } from "../../../src/engines/history/sqlite-store.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";
import { describeHistoryStoreContract, makeClock, perfResult, stressResult } from "./contract.js";

describeHistoryStoreContract("jsonl", ({ cwd, isoNow }) =>
  createJsonlStore({ cwd, isoNow, captureGit: false }),
);
describeHistoryStoreContract("sqlite", ({ cwd, isoNow }) =>
  createSqliteStore({ cwd, isoNow, captureGit: false }),
);
describeHistoryStoreContract("sqlite via createHistoryStore (lazy wrapper)", ({ cwd, isoNow }) =>
  openHistoryStore({ cwd, isoNow, captureGit: false, backend: "sqlite" }),
);

describe("JSONL ↔ SQLite parity", () => {
  let a: TmpDir;
  let b: TmpDir;
  beforeEach(async () => {
    a = await makeTmpDir("sw-par-a-");
    b = await makeTmpDir("sw-par-b-");
  });
  afterEach(async () => {
    await a.cleanup();
    await b.cleanup();
  });

  // Built once and shared, so both stores store byte-identical reports (same sha256).
  const RESULTS: EngineResult[] = Array.from({ length: 12 }, (_, i) => ({
    ...(i % 4 === 3
      ? stressResult()
      : perfResult(100 + (i % 5), i % 3 === 0 ? [{ title: `f${i % 2}` }] : [])),
    runId: `run-${i}`,
  }));

  async function script(store: HistoryStore): Promise<unknown> {
    let n = 0;
    const id = () => `01PARITY${String(++n).padStart(18, "0")}`;
    const out: unknown[] = [];
    for (let i = 0; i < 12; i++)
      out.push(
        await store.append({
          id: id(),
          results: [RESULTS[i] as EngineResult],
          label: i % 2 ? "odd" : "even",
          tags: [`t${i % 3}`],
          git: { commit: `c${i}`, branch: i < 6 ? "main" : "dev", dirty: false },
        }),
      );
    await store.setBaseline("main", "01PARITY000000000000000001");
    out.push(await store.list());
    out.push(await store.list({ engine: "stress", limit: 2 }));
    out.push(await store.query({ label: "odd", branch: "dev" }));
    out.push(await store.query({ tag: "t1", hasFindings: false }));
    out.push((await store.trend("p95", { branch: "main" })).points);
    out.push(await store.get("01PARITY000000000000000005"));
    out.push(await store.diff("baseline:main", ["01PARITY000000000000000011", "01PARITY000000000000000012"]));
    out.push(await store.prune({ keepLast: 4 }));
    out.push(await store.list());
    out.push(await store.prune({ keepLast: 2, compact: false }));
    out.push(await store.list());
    out.push(await store.listBaselines());
    const v = await store.verify();
    out.push({ ok: v.ok, checked: v.checked, errors: v.errors });
    return out;
  }

  it("the same operations give identical results on both backends", async () => {
    const isoA = makeClock();
    const isoB = makeClock();
    const ra = await script(createJsonlStore({ cwd: a.path, isoNow: isoA, captureGit: false }));
    const rb = await script(await createSqliteStore({ cwd: b.path, isoNow: isoB, captureGit: false }));
    expect(rb).toEqual(ra);
  });
});
