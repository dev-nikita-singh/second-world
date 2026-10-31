/**
 * In-memory evidence store with fingerprint dedup.
 * See docs/03-engines/evidence-and-history.md §A.1 and docs/02-architecture.md §1.
 * Same fingerprint → occurrences += n, lastSeen = max, firstSeen = min; the first id is kept.
 */
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { EvidenceStore } from "../types.js";
import {
  type EngineId,
  type EngineResult,
  type Finding,
  type FindingInput,
  FindingSchema,
  type Limitation,
} from "./schemas.js";

export interface EvidenceStoreEx extends EvidenceStore {
  limitations(engine?: EngineId): Array<Limitation & { engine: EngineId }>;
  get(idOrFingerprint: string): Finding | undefined;
  readonly size: number;
  clear(): void;
}

const MAX_EVIDENCE_PER_FINDING = 50;

export function createEvidenceStore(
  opts: { onFinding?: (f: Finding, isNew: boolean) => void } = {},
): EvidenceStoreEx {
  const byFp = new Map<string, Finding>();
  const byId = new Map<string, Finding>();
  const lims: Array<Limitation & { engine: EngineId }> = [];
  const res: EngineResult[] = [];

  return {
    addFinding(f: Finding): Finding {
      const existing = byFp.get(f.fingerprint);
      if (existing) {
        existing.occurrences += f.occurrences ?? 1;
        if (f.lastSeen > existing.lastSeen) existing.lastSeen = f.lastSeen;
        if (f.firstSeen < existing.firstSeen) existing.firstSeen = f.firstSeen;
        for (const e of f.evidence) {
          if (existing.evidence.length >= MAX_EVIDENCE_PER_FINDING) break;
          const key = JSON.stringify(e);
          if (!existing.evidence.some((x) => JSON.stringify(x) === key)) existing.evidence.push(e);
        }
        opts.onFinding?.(existing, false);
        return existing;
      }
      const copy: Finding = { ...f, evidence: [...f.evidence] };
      byFp.set(copy.fingerprint, copy);
      byId.set(copy.id, copy);
      opts.onFinding?.(copy, true);
      return copy;
    },
    addLimitation(engine: EngineId, l: Limitation): void {
      if (lims.some((x) => x.engine === engine && x.code === l.code && x.message === l.message)) return;
      lims.push({ ...l, engine });
    },
    findings(filter?: { engine?: EngineId }): Finding[] {
      const all = [...byFp.values()];
      return filter?.engine ? all.filter((f) => f.engine === filter.engine) : all;
    },
    results: () => [...res],
    addResult(r: EngineResult): void {
      res.push(r);
      for (const f of r.findings) {
        if (!byFp.has(f.fingerprint)) {
          byFp.set(f.fingerprint, f);
          byId.set(f.id, f);
        }
      }
    },
    limitations(engine?: EngineId) {
      return engine ? lims.filter((l) => l.engine === engine) : [...lims];
    },
    get(k: string) {
      return byId.get(k) ?? byFp.get(k);
    },
    get size() {
      return byFp.size;
    },
    clear() {
      byFp.clear();
      byId.clear();
      lims.length = 0;
      res.length = 0;
    },
  };
}

export type CreateFindingInput = Omit<FindingInput, "id" | "firstSeen" | "lastSeen" | "fingerprint"> & {
  id?: string;
  fingerprint?: string;
  firstSeen?: string;
  lastSeen?: string;
};

/** Default fingerprint: sha256(engine | ruleId | category | title (digits masked) | sorted affected), 16 hex. */
export function defaultFingerprint(
  f: Pick<FindingInput, "engine" | "ruleId" | "category" | "title" | "affected">,
): string {
  const parts = [
    f.engine,
    f.ruleId ?? "",
    f.category,
    f.title
      .trim()
      .toLowerCase()
      .replace(/\d+(\.\d+)?/g, "#"),
    ...[...(f.affected ?? [])].sort(),
  ];
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 16);
}

/**
 * Builds a validated Finding: fills id (ULID), fingerprint, firstSeen/lastSeen and schema defaults.
 * Throws a ZodError if the input is invalid (engine bug).
 */
export function createFinding(
  input: CreateFindingInput,
  ctx: { newId?: () => string; clock?: { isoNow(): string } } = {},
): Finding {
  const ts = ctx.clock?.isoNow() ?? new Date().toISOString();
  return FindingSchema.parse({
    ...input,
    id: input.id ?? (ctx.newId ? ctx.newId() : ulid()),
    fingerprint: input.fingerprint ?? defaultFingerprint(input),
    firstSeen: input.firstSeen ?? ts,
    lastSeen: input.lastSeen ?? input.firstSeen ?? ts,
  });
}
