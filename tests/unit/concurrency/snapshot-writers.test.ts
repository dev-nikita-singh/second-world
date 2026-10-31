/**
 * Concurrent writers of `.second-world/` caches outside the history store (Plan wave 7 §A).
 * Model snapshots (src/engines/model/snapshot.ts) and the architecture facts cache
 * (src/engines/architecture/cache.ts) use a temp name of `<file>.<pid>.tmp`, which is not unique
 * between two writers in one process: 4 of 8 saves reject (ENOENT/EPERM on rename). `it.fails` until the
 * owners switch to a unique temp name (+ rename retry); reported to main by sw-race7.
 */
import { readdir, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsCache } from "../../../src/engines/architecture/cache.js";
import { saveModelSnapshot } from "../../../src/engines/model/snapshot.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir;
beforeEach(async () => {
  tmp = await makeTmpDir("sw-snap-");
});
afterEach(async () => {
  await tmp.cleanup();
});

describe("concurrent snapshot/cache writers in one process", () => {
  it.fails("8 parallel model snapshots: all succeed, latest.json complete, no temp files", async () => {
    const models = Array.from({ length: 8 }, (_, i) => ({
      schemaVersion: 1,
      builtAt: `2026-01-01T00:00:0${i}.000Z`,
      nodes: [],
      edges: [],
      merges: [],
      pad: "m".repeat(100_000 + i),
    }));
    const results = await Promise.allSettled(
      models.map((m) => saveModelSnapshot(m as never, { dir: tmp.path })),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    JSON.parse(await readFile(tmp.join("latest.json"), "utf8"));
    expect((await readdir(tmp.path)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it.fails("8 parallel saves of one architecture facts cache: all succeed", async () => {
    const caches = Array.from({ length: 8 }, () => new FactsCache(tmp.path, "ns"));
    const results = await Promise.allSettled(caches.map((c) => c.save()));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
  });
});
