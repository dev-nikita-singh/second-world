/**
 * Schema migrations, applied on read; stored reports are never rewritten in place.
 * See docs/03-engines/evidence-and-history.md §B.3.
 *
 * v0 (legacy / foreign): a bare EngineResult[] or `{ results: EngineResult[] }` without schemaVersion.
 * v1: HistoryRun.
 */
import type { EngineResult } from "../../core/evidence/schemas.js";
import { extractMetrics, overallStatus } from "./metrics.js";
import { HISTORY_SCHEMA_VERSION, type HistoryRun } from "./types.js";

type Migration = (
  doc: Record<string, unknown>,
  ctx: { id: string; createdAt: string },
) => Record<string, unknown>;

const MIGRATIONS: Record<number, Migration> = {
  0: (doc, ctx) => {
    const results = (Array.isArray(doc) ? doc : (doc.results as EngineResult[] | undefined)) ?? [];
    return {
      schemaVersion: 1,
      id: (doc as { id?: string }).id ?? ctx.id,
      createdAt: (doc as { createdAt?: string }).createdAt ?? ctx.createdAt,
      tags: [],
      engines: [...new Set(results.map((r) => r.engine))],
      status: overallStatus(results),
      metrics: extractMetrics(results),
      results,
    };
  },
};

export class UnsupportedSchemaError extends Error {
  constructor(readonly version: number) {
    super(
      `History report schemaVersion ${version} is newer than this SECOND WORLD (supports ${HISTORY_SCHEMA_VERSION}). Upgrade the tool.`,
    );
    this.name = "UnsupportedSchemaError";
  }
}

export function migrateRun(raw: unknown, ctx: { id: string; createdAt: string }): HistoryRun {
  let doc = (Array.isArray(raw) ? { results: raw } : raw) as Record<string, unknown>;
  let v = typeof doc.schemaVersion === "number" ? doc.schemaVersion : 0;
  if (v > HISTORY_SCHEMA_VERSION) throw new UnsupportedSchemaError(v);
  for (; v < HISTORY_SCHEMA_VERSION; v++) {
    const m = MIGRATIONS[v];
    if (!m) throw new Error(`no history migration from schemaVersion ${v}`);
    doc = m(doc, ctx);
  }
  return doc as unknown as HistoryRun;
}
