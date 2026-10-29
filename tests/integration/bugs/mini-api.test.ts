import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SafetyError } from "../../../src/core/errors.js";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import {
  type BugsData,
  type BugsInputLoose,
  replayFinding,
  runBugHunt,
} from "../../../src/engines/bugs/index.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";
import { CONTRACT, type MiniApi, startMiniApi } from "./mini-api.js";

let api: MiniApi;
let tmp: TmpDir;
let base: BugsInputLoose;
let result: EngineResult<BugsData>;

beforeAll(async () => {
  api = await startMiniApi();
  tmp = await makeTmpDir("sw-bugs-");
  // A user-owned invariant module (loaded via dynamic import).
  await writeFile(
    tmp.join("counter-invariant.mjs"),
    `export default function noLostUpdate(burst) {
       const values = burst.responses.filter((r) => r.status === 200).map((r) => r.body.value);
       return new Set(values).size === values.length || \`lost update: \${values.length} increments, \${new Set(values).size} distinct values\`;
     }\n`,
  );
  base = {
    target: api.url,
    openapi: CONTRACT as unknown as Record<string, unknown>,
    seed: 7,
    allowMutations: true,
    hooks: { reset: { http: { method: "POST", url: `${api.url}/__reset` } } },
    stateful: { runs: 12, maxCommands: 8 },
    concurrency: [
      {
        name: "counter",
        operation: "POST /counter/inc",
        burst: 8,
        invariant: tmp.join("counter-invariant.mjs"),
      },
    ],
    artifactsDir: tmp.join("artifacts"),
  };
  result = await runBugHunt(base, { seed: 7 });
}, 60_000);

afterAll(async () => {
  await api?.close();
  await tmp?.cleanup();
});

const defects = (r: EngineResult<BugsData>) =>
  r.findings.filter((f) => f.classification === "reproduced-defect");

describe("Bug Hunter vs inline mini API", () => {
  it("model-based testing finds the delete-that-does-not-delete bug, minimised", () => {
    const f = defects(result).find((x) => x.ruleId === "bugs/state-model-mismatch");
    expect(f, JSON.stringify(result.findings.map((x) => x.title))).toBeDefined();
    const fp = f?.fingerprint as string;
    const rep = result.data?.reproductions[fp];
    expect(rep?.case.steps.length).toBeLessThanOrEqual(3);
    expect(rep?.case.steps.map((s) => s.request.method)).toEqual(["POST", "DELETE", "GET"]);
    expect(rep?.curl.length).toBe(rep?.case.steps.length);
    expect(f?.reproduction?.command).toBe(`sw replay ${fp}`);
  });

  it("concurrency burst + user invariant module detects the lost update", () => {
    const f = result.findings.find((x) => x.ruleId === "bugs/race-lost-update");
    expect(f).toBeDefined();
    expect(f?.classification).toBe("reproduced-defect");
    const s = result.data?.findings.find((x) => x.fingerprint === f?.fingerprint);
    expect(s?.replays).toBeGreaterThanOrEqual(3);
    expect(s?.wilson.lower).toBeGreaterThan(0);
  });

  it("documented 404s and correct behaviour are not reported (precision)", () => {
    const rules = defects(result)
      .map((f) => f.ruleId)
      .sort();
    expect(rules).toEqual(["bugs/race-lost-update", "bugs/state-model-mismatch"]);
    const row = result.data?.matrix.find((r) => r.operation === "GET /items/{id}");
    expect(row?.statuses["404"] ?? 0).toBeGreaterThan(0);
    expect(
      result.findings.some(
        (f) =>
          f.affected.includes("GET /items/{id}") &&
          f.classification === "reproduced-defect" &&
          f.ruleId !== "bugs/state-model-mismatch",
      ),
    ).toBe(false);
  });

  it("matrix, coverage and redacted artifacts are produced", () => {
    const d = result.data as BugsData;
    expect(d.mode).toBe("contract");
    expect(d.contract?.version).toBe("3.0");
    expect(d.coverage.operations.exercised).toBe(d.coverage.operations.total);
    for (const t of [
      "contract",
      "boundary",
      "equivalence",
      "property",
      "negative",
      "stateful",
      "concurrency",
    ]) {
      expect(d.coverage.techniques[t as "contract"] ?? 0, t).toBeGreaterThan(0);
    }
    // One JSON reproduction + one HAR 1.2 (bugs-<fp>/reproduction.har) per finding.
    expect(result.artifacts.length).toBe(2 * Object.keys(d.reproductions).length);
    expect(result.artifacts.filter((a) => a.path.endsWith("reproduction.har"))).toHaveLength(
      Object.keys(d.reproductions).length,
    );
  });

  it("replay of a recorded finding (from its artifact file) reproduces it", async () => {
    const f = defects(result).find((x) => x.ruleId === "bugs/state-model-mismatch");
    const path = f?.reproduction?.artifacts[0] as string;
    const r = await replayFinding(base, { artifactPath: path }, { seed: 7 }, { runs: 3 });
    expect(r.classification).toBe("reproduced-defect");
    expect(r.failures).toBe(3);
    expect(r.runs).toBe(3);
  });

  it("mutations without allowMutations are blocked (never sent)", async () => {
    const before = { ...api.methods };
    const r = await runBugHunt(
      {
        ...base,
        allowMutations: undefined,
        hooks: {},
        concurrency: [],
        techniques: ["contract", "boundary", "stateful"],
        artifactsDir: undefined,
      },
      { seed: 7 },
    );
    expect(api.methods.POST ?? 0).toBe(before.POST ?? 0);
    expect(api.methods.DELETE ?? 0).toBe(before.DELETE ?? 0);
    expect(r.limitations.some((l) => l.code === "BUGS_MUTATIONS_BLOCKED")).toBe(true);
    expect(r.data?.requests.mutationsBlocked).toBeGreaterThan(0);
    expect(defects(r)).toEqual([]);
  });

  it("an approved run (--yes) may mutate", async () => {
    const before = api.methods.POST ?? 0;
    const safety = createSafetyGuard({}, { interactive: false, approve: true });
    const r = await runBugHunt(
      {
        ...base,
        allowMutations: undefined,
        hooks: {},
        concurrency: [],
        techniques: ["contract"],
        artifactsDir: undefined,
      },
      { seed: 7, safety },
    );
    expect(api.methods.POST ?? 0).toBeGreaterThan(before);
    expect(r.data?.mutationsAllowed).toBe(true);
  });

  it("discovery mode (no contract) emits observations only and a draft contract", async () => {
    const r = await runBugHunt(
      { target: api.url, discover: { paths: ["GET /", "GET /items", "GET /boom"] } },
      { seed: 1 },
    );
    expect(r.data?.mode).toBe("discovery");
    expect(defects(r)).toEqual([]);
    expect(
      r.findings.some((f) => f.classification === "observation" && f.affected.includes("GET /boom")),
    ).toBe(true);
    const paths = (r.data?.draftContract as { paths: Record<string, unknown> } | undefined)?.paths ?? {};
    expect(Object.keys(paths).sort()).toEqual(["/", "/boom", "/items"]);
    expect(r.status).toBe("passed");
  });

  it("config assertions, per-exchange invariant modules and command hooks", async () => {
    await writeFile(
      tmp.join("price-invariant.mjs"),
      [
        "export function nonNegativePrice(ex) { const items = ex.body?.items ?? []; return items.every((i) => i.price >= 0) || 'negative price'; }",
        "export function alwaysFails(ex) { return ex.status === 200 ? 'demo invariant violated' : true; }",
        "",
      ].join("\n"),
    );
    const r = await runBugHunt(
      {
        ...base,
        concurrency: [],
        artifactsDir: undefined,
        techniques: ["contract"],
        hooks: { ...base.hooks, setup: { command: [process.execPath, "-e", "process.exit(0)"] } },
        assertions: [
          { operation: "GET /items", json: [{ pointer: "/items", type: "array" }], maxDuration: 5000 },
          { name: "cache header", operation: "GET /items", headers: { "cache-control": "max-age" } },
        ],
        invariants: [
          { module: tmp.join("price-invariant.mjs"), export: "nonNegativePrice" },
          { module: tmp.join("price-invariant.mjs"), export: "alwaysFails", operations: ["GET /items"] },
        ],
      },
      { seed: 7 },
    );
    const rules = defects(r).map((f) => `${f.ruleId} ${f.affected[0]}`);
    expect(rules).toContain("bugs/assertion-failed GET /items");
    expect(rules).toContain("bugs/invariant-violated GET /items");
    expect(rules.filter((x) => x.startsWith("bugs/assertion-failed"))).toHaveLength(1);
    expect(rules.filter((x) => x.startsWith("bugs/invariant-violated"))).toHaveLength(1);
    expect(r.data?.requests.hookRuns).toBeGreaterThan(0);
  });

  it("refuses a public target", async () => {
    await expect(
      runBugHunt({ target: "http://example.com", openapi: CONTRACT as unknown as Record<string, unknown> }),
    ).rejects.toBeInstanceOf(SafetyError);
  });
});
