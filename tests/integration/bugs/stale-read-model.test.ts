/**
 * Gap 4 (sw-gaps-w8, found by sw-real2-w8 on orders-jobs-api): the Bug Hunter's model-based
 * stateful technique never produced create → read → update → read within default settings, so a
 * read cache that an update forgets to invalidate went unnoticed. With default `stateful` settings
 * (runs 4, maxCommands 8) such a sequence must be reached and the stale read reported.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { runBugHunt } from "../../../src/engines/bugs/index.js";
import {
  NOTES_OPENAPI,
  NOTES_RESOURCES,
  NOTES_ROLES,
  type NotesServer,
  startNotesServer,
} from "../agent/stale-cache-server.js";

async function bugsRun(s: NotesServer, seed: number): Promise<EngineResult> {
  return runBugHunt(
    {
      target: s.url,
      openapi: NOTES_OPENAPI,
      seed,
      allowMutations: true,
      techniques: ["stateful"],
      auth: { roles: NOTES_ROLES },
      hooks: { reset: { http: { method: "POST", url: `${s.url}/__test/reset` } } },
      stateful: { resources: NOTES_RESOURCES },
    },
    { seed },
  );
}

const staleFindings = (r: EngineResult) =>
  r.findings.filter(
    (f) => f.ruleId === "bugs/state-model-mismatch" && f.classification === "reproduced-defect",
  );

/** Did some note see create → read → update → read (in this order, not necessarily adjacent)? */
function sawReadAfterUpdate(s: NotesServer): boolean {
  for (const h of s.sequences) {
    const iGet = h.indexOf("GET");
    const iPut = h.indexOf("PUT", iGet + 1);
    if (iGet > 0 && iPut > 0 && h.indexOf("GET", iPut + 1) > 0) return true;
  }
  return false;
}

describe("bugs model-based stateful: read after update", () => {
  let buggy: NotesServer;
  let fine: NotesServer;
  beforeAll(async () => {
    buggy = await startNotesServer({ staleCache: true });
    fine = await startNotesServer({ staleCache: false });
  });
  afterAll(async () => {
    await buggy?.close();
    await fine?.close();
  });

  for (const seed of [1, 7, 42]) {
    it(`seed ${seed}: stale cache after PUT is reported with default settings`, async () => {
      const r = await bugsRun(buggy, seed);
      const f = staleFindings(r);
      const seen = [...buggy.counts.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
      expect(f.length, `requests seen: ${seen}`).toBeGreaterThan(0);
      expect(
        f.some((x) => x.affected[0] === "GET /notes/{id}"),
        JSON.stringify(f.map((x) => x.affected)),
      ).toBe(true);
    }, 60_000);
  }

  it("correct server: the sequence is exercised and nothing is reported", async () => {
    const r = await bugsRun(fine, 1);
    expect(sawReadAfterUpdate(fine)).toBe(true);
    expect(r.findings.filter((f) => f.classification === "reproduced-defect")).toEqual([]);
  }, 60_000);
});
