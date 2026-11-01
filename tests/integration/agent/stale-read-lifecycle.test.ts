/**
 * Gap 3 (sw-gaps-w8): the agent's lifecycle hypotheses were create → read-back only, so a stale
 * read after an update (GET cached, PUT forgets to invalidate) was never probed. Lifecycle now also
 * proposes create → read → update → read when the resource has an update operation and a body.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { type AgentData, runAgent } from "../../../src/engines/agent/index.js";
import {
  NOTES_OPENAPI,
  NOTES_RESOURCES,
  NOTES_ROLES,
  type NotesServer,
  startNotesServer,
} from "./stale-cache-server.js";

async function agentRun(s: NotesServer): Promise<EngineResult<AgentData>> {
  return runAgent(
    {
      target: s.url,
      openapi: NOTES_OPENAPI,
      seed: 7,
      allowMutations: true,
      allowDestructive: true,
      auth: { roles: NOTES_ROLES },
      hooks: { reset: { http: { method: "POST", url: `${s.url}/__test/reset` } } },
      techniques: ["lifecycle"],
      resources: NOTES_RESOURCES,
      budget: { maxIterations: 20, maxRequests: 200, patience: 10 },
    },
    { seed: 7 },
  );
}

const stale = (r: EngineResult<AgentData>) =>
  r.findings.filter(
    (f) =>
      f.ruleId === "bugs/state-model-mismatch" &&
      f.classification === "reproduced-defect" &&
      f.affected[0] === "GET /notes/{id}",
  );

const updateHypotheses = (r: EngineResult<AgentData>) =>
  (r.data as AgentData).hypotheses.filter((h) => h.technique === "lifecycle" && /update/i.test(h.title));

describe("agent lifecycle: read after update", () => {
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

  it("stale cache after PUT → reproduced bugs/state-model-mismatch on the read", async () => {
    const r = await agentRun(buggy);
    expect(updateHypotheses(r).length).toBeGreaterThan(0);
    expect(stale(r).length).toBeGreaterThan(0);
    // The minimised reproduction still contains the update (removing it makes the read fresh).
    const f = stale(r)[0];
    expect(JSON.stringify(f?.evidence ?? f)).toMatch(/PUT/);
  }, 60_000);

  it("cache invalidated on PUT → no finding", async () => {
    const r = await agentRun(fine);
    expect(r.findings.filter((f) => f.classification === "reproduced-defect")).toEqual([]);
    const upd = updateHypotheses(r);
    expect(upd.length).toBeGreaterThan(0);
    expect(upd.every((h) => h.outcome === "passed")).toBe(true);
  }, 60_000);
});
