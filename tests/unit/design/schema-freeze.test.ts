/**
 * Schema freeze v1 (docs/03-engines/evidence-and-history.md §A.5, §B.3; docs/16-system-design.md
 * §11 "Versioned schemas"). Persisted / exchanged JSON must not change shape silently:
 *   - evidence: the Zod schemas of EngineResult / Finding / Evidence (JSON Schema snapshot);
 *   - report:   the canonical JSON report (renderJson(combineResults(...))) for a fixed input;
 *   - history:  the index line (runs.jsonl) and the stored run (runs/<id>.json.gz).
 * A change to any snapshot is a schema change: bump the version constant and add a migration
 * (src/engines/history/migrations.ts) instead of updating the snapshot, unless the change is
 * purely additive-optional (then update with `-u` and say so in CHANGELOG.md).
 *
 * Migration tests: records written by older versions (frozen literals below) still load.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type EngineResult,
  EngineResultSchema,
  EvidenceSchema,
  FindingSchema,
  SCHEMA_VERSION,
} from "../../../src/core/evidence/schemas.js";
import {
  createJsonlStore,
  HISTORY_SCHEMA_VERSION,
  type HistoryStore,
  migrateRun,
  UnsupportedSchemaError,
} from "../../../src/engines/history/index.js";
import { combineResults, renderJson } from "../../../src/engines/reporting/index.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** A small but complete v1 EngineResult (one finding, every evidence field kind used once). */
function fixedResult(): EngineResult {
  return EngineResultSchema.parse({
    engine: "performance",
    runId: "01JFREEZE00000000000000000",
    status: "failed",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:10.000Z",
    findings: [
      {
        id: "f-1",
        fingerprint: "fp-1",
        engine: "performance",
        ruleId: "perf/threshold",
        category: "performance",
        title: "p95 above threshold",
        severity: "high",
        classification: "threshold-breach",
        confidence: 0.9,
        evidence: [
          { kind: "threshold", expression: "http.p95 < 200ms", actual: 250, passed: false },
          { kind: "measurement", metric: "http.p95", value: 250, unit: "ms" },
        ],
        firstSeen: "2026-01-01T00:00:10.000Z",
        lastSeen: "2026-01-01T00:00:10.000Z",
      },
    ],
    data: { totals: { requests: 100 } },
  }) as EngineResult;
}

describe("version constants (v1)", () => {
  it("evidence, history and report are all schemaVersion 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(HISTORY_SCHEMA_VERSION).toBe(1);
    const r = combineResults([fixedResult()]);
    expect(r.schemaVersion).toBe(1);
    expect(r.kind).toBe("second-world-report");
  });
});

describe("evidence schema freeze", () => {
  it("EngineResult / Finding / Evidence JSON Schemas match the v1 snapshot", async () => {
    const schemas = {
      EngineResult: z.toJSONSchema(EngineResultSchema),
      Finding: z.toJSONSchema(FindingSchema),
      Evidence: z.toJSONSchema(EvidenceSchema),
    };
    await expect(json(schemas)).toMatchFileSnapshot("./__snapshots__/evidence-v1.schema.json.snap");
  });

  it("a v1 finding written today parses unchanged (round trip)", () => {
    const r = fixedResult();
    expect(EngineResultSchema.parse(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });
});

describe("report JSON freeze", () => {
  it("canonical JSON report for a fixed input matches the v1 snapshot", async () => {
    const report = combineResults(
      [fixedResult()],
      { runId: "01JFREEZE00000000000000000", toolVersion: "0.0.0-freeze", command: "sw perf" },
      "high",
    );
    await expect(renderJson(report)).toMatchFileSnapshot("./__snapshots__/report-v1.json.snap");
  });
});

describe("history record freeze + migrations", () => {
  let tmp: TmpDir;
  let store: HistoryStore;
  beforeEach(async () => {
    tmp = await makeTmpDir("sw-design-hist-");
    store = createJsonlStore({ cwd: tmp.path, captureGit: false });
  });
  afterEach(async () => tmp.cleanup());

  it("index line and stored run match the v1 snapshot", async () => {
    await store.append({
      id: "01JFREEZE00000000000000000",
      createdAt: "2026-01-01T00:00:11.000Z",
      git: false,
      label: "freeze",
      tags: ["t"],
      results: [fixedResult()],
    });
    const index = (await readFile(path.join(store.dir, "runs.jsonl"), "utf8")).trim();
    const entry = JSON.parse(index) as Record<string, unknown>;
    // gzip bytes depend on the zlib build; the shape and the rest are frozen.
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof entry.bytes).toBe("number");
    entry.sha256 = "<sha256>";
    entry.bytes = "<bytes>";
    const run = JSON.parse(
      gunzipSync(await readFile(path.join(store.dir, "runs", "01JFREEZE00000000000000000.json.gz"))).toString(
        "utf8",
      ),
    );
    await expect(json({ indexEntry: entry, run })).toMatchFileSnapshot(
      "./__snapshots__/history-v1.json.snap",
    );
  });

  /** Writes a raw (possibly old-format) report + its index line, as an older SECOND WORLD would have. */
  async function plant(id: string, doc: unknown, createdAt = "2025-06-01T00:00:00.000Z"): Promise<void> {
    const gz = gzipSync(Buffer.from(JSON.stringify(doc)));
    await mkdir(path.join(store.dir, "runs"), { recursive: true });
    await writeFile(path.join(store.dir, "runs", `${id}.json.gz`), gz);
    const entry = {
      v: 1,
      id,
      createdAt,
      tags: [],
      engines: ["performance"],
      status: "failed",
      metrics: {},
      findings: { count: 1, maxSeverity: "high", fingerprints: ["fp-1"] },
      file: `runs/${id}.json.gz`,
      sha256: sha256(gz),
      bytes: gz.length,
    };
    await writeFile(path.join(store.dir, "runs.jsonl"), `${JSON.stringify(entry)}\n`, { flag: "a" });
  }

  it("v0 `{ results }` wrapper (no schemaVersion) loads as v1", async () => {
    await plant("01JV0WRAPPED00000000000000", { results: [fixedResult()] });
    const run = await store.get("01JV0WRAPPED00000000000000");
    expect(run?.schemaVersion).toBe(1);
    expect(run?.id).toBe("01JV0WRAPPED00000000000000");
    expect(run?.createdAt).toBe("2025-06-01T00:00:00.000Z");
    expect(run?.engines).toEqual(["performance"]);
    expect(run?.status).toBe("failed");
    expect(run?.results[0]?.findings[0]?.fingerprint).toBe("fp-1");
    expect((await store.verify()).ok).toBe(true);
  });

  it("v1 record frozen from the first release still loads unchanged", async () => {
    const v1 = {
      schemaVersion: 1,
      id: "01JV1FROZEN000000000000000",
      createdAt: "2025-06-02T00:00:00.000Z",
      label: "old",
      tags: ["ci"],
      engines: ["performance"],
      status: "failed",
      git: { commit: "0123456789abcdef0123456789abcdef01234567", branch: "main", dirty: false },
      metrics: { "performance.http.p95": 250 },
      results: [JSON.parse(JSON.stringify(fixedResult()))],
    };
    await plant(v1.id, v1, v1.createdAt);
    const run = await store.get(v1.id);
    expect(run).toEqual(v1);
    const [listed] = await store.list();
    expect(listed?.id).toBe(v1.id);
  });

  it("migrateRun: v0 bare array, v0 wrapper, v1 passthrough, newer version rejected", () => {
    const ctx = { id: "X", createdAt: "2025-01-01T00:00:00.000Z" };
    const fromArray = migrateRun([fixedResult()], ctx);
    const fromWrapper = migrateRun({ results: [fixedResult()] }, ctx);
    expect(fromArray).toEqual(fromWrapper);
    expect(fromArray.schemaVersion).toBe(HISTORY_SCHEMA_VERSION);
    expect(fromArray.tags).toEqual([]);
    const v1 = { ...fromArray, label: "keep" };
    expect(migrateRun(v1, ctx)).toBe(v1);
    expect(() => migrateRun({ schemaVersion: HISTORY_SCHEMA_VERSION + 1 }, ctx)).toThrow(
      UnsupportedSchemaError,
    );
  });
});
