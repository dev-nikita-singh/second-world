/**
 * Read side of `sw ui`: runs, reports, findings, config, doctor and target health, all from the existing
 * APIs (history store, world.report, config loader, probe). Nothing new is stored.
 * Reports are served as the CLI wrote them to history (results are redacted when they are recorded, the
 * same data `sw report --run` renders); the config is masked with the config printer's redactor.
 */
import { request } from "undici";
import type { EngineResult, Finding, Severity } from "../../core/evidence/schemas.js";
import type { ReportFormatName, World } from "../../core/world.js";
import type { HistoryRun, IndexEntry } from "../../engines/history/types.js";
import type {
  FindingGroup,
  FindingsPage,
  RunDetail,
  RunSummary,
  RunsPage,
  TargetInfo,
} from "../shared/api-types.js";
import { exitMeaning } from "./jobs.js";

/** The parts of the history store the UI reads (src/engines/history/store.ts). */
export interface UiHistoryStore {
  list(o?: { limit?: number; includeCompacted?: boolean }): Promise<IndexEntry[]>;
  get(id: string): Promise<HistoryRun | null>;
}

export class NotFoundError extends Error {}

const RUN_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function validRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

export function summarize(e: IndexEntry): RunSummary {
  const p95 = e.metrics["performance.http.p95"] ?? e.metrics["stress.http.p95"];
  return {
    id: e.id,
    createdAt: e.createdAt,
    engines: [...e.engines],
    ...(e.label ? { label: e.label } : {}),
    status: e.status,
    findings: { total: e.findings.count, maxSeverity: e.findings.maxSeverity },
    ...(typeof p95 === "number" ? { p95Ms: p95 } : {}),
    ...(e.compacted ? { compacted: true } : {}),
  };
}

export async function historyStore(world: World): Promise<UiHistoryStore> {
  return (await world.history.store()) as unknown as UiHistoryStore;
}

/** Newest first; `before` = the id after which to continue (exclusive). */
export async function runsPage(
  store: UiHistoryStore,
  q: { engine?: string; status?: string; limit?: number; before?: string; search?: string },
): Promise<RunsPage> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const all = await store.list({ limit: 100_000, includeCompacted: true });
  const s = q.search?.toLowerCase();
  let rows = all.filter(
    (e) =>
      (!q.engine || e.engines.includes(q.engine as never)) &&
      (!q.status || e.status === q.status) &&
      (!s || e.id.toLowerCase().includes(s) || (e.label ?? "").toLowerCase().includes(s)),
  );
  if (q.before) {
    const i = rows.findIndex((e) => e.id === q.before);
    rows = i >= 0 ? rows.slice(i + 1) : [];
  }
  const page = rows.slice(0, limit);
  return { runs: page.map(summarize), next: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}

async function loadRun(store: UiHistoryStore, id: string): Promise<{ entry: IndexEntry; run: HistoryRun }> {
  if (!validRunId(id)) throw new NotFoundError(`No run "${id}"`);
  const entry = (await store.list({ limit: 100_000, includeCompacted: true })).find((e) => e.id === id);
  if (!entry) throw new NotFoundError(`No run "${id}" in history`);
  if (entry.compacted)
    throw new NotFoundError(`Run ${id} was compacted by retention: only its summary is kept`);
  const run = await store.get(id);
  if (!run) throw new NotFoundError(`No run "${id}" in history`);
  return { entry, run };
}

function combined(world: World, run: HistoryRun, version: string): unknown {
  return world.report.combine(run.results, { runId: run.id, toolVersion: version, command: "sw ui" });
}

export async function runDetail(
  world: World,
  store: UiHistoryStore,
  id: string,
  version: string,
): Promise<RunDetail> {
  const { entry, run } = await loadRun(store, id);
  const report = combined(world, run, version);
  const exitCode = world.report.exitCode(report);
  return { run: summarize(entry), report, exitCode, exitMeaning: exitMeaning(exitCode) };
}

export const DOWNLOAD_FORMATS: Record<string, { format: ReportFormatName; type: string; ext: string }> = {
  json: { format: "json", type: "application/json; charset=utf-8", ext: "json" },
  md: { format: "md", type: "text/markdown; charset=utf-8", ext: "md" },
  html: { format: "html", type: "text/html; charset=utf-8", ext: "html" },
  sarif: { format: "sarif", type: "application/sarif+json; charset=utf-8", ext: "sarif" },
  junit: { format: "junit", type: "application/xml; charset=utf-8", ext: "xml" },
};

export async function renderRun(
  world: World,
  store: UiHistoryStore,
  id: string,
  fmt: string,
  version: string,
): Promise<{ body: string; type: string; filename: string }> {
  const f = DOWNLOAD_FORMATS[fmt];
  if (!f) throw new NotFoundError(`Unknown report format "${fmt}"`);
  const { run } = await loadRun(store, id);
  const body = world.report.render(combined(world, run, version), f.format);
  return { body, type: f.type, filename: `second-world-${id}.${f.ext}` };
}

export async function compareRuns(
  world: World,
  store: UiHistoryStore,
  baseline: string,
  current: string,
): Promise<unknown> {
  await loadRun(store, baseline);
  await loadRun(store, current);
  return world.history.compare({ baseline, current });
}

function whereOf(f: Finding): string | undefined {
  const loc = f.locations[0];
  if (loc) return `${loc.file}:${loc.line}`;
  return f.affected[0];
}

/**
 * Findings across the most recent `scan` runs, grouped by fingerprint. "open" = reported by the latest
 * scanned run of the same engine (a later run of that engine without it means it is gone).
 */
export async function findingsAcrossRuns(
  store: UiHistoryStore,
  scan = 50,
  cache?: Map<string, HistoryRun>,
): Promise<FindingsPage> {
  const entries = (await store.list({ limit: scan })).filter((e) => !e.compacted);
  const groups = new Map<string, FindingGroup>();
  /** engine → id of its latest scanned run */
  const latestByEngine = new Map<string, string>();
  const seenIn = new Map<string, Set<string>>();
  for (const e of entries) {
    // Newest first: the first run seen per engine is that engine's latest.
    for (const eng of e.engines) if (!latestByEngine.has(eng)) latestByEngine.set(eng, e.id);
    if (e.findings.count === 0) continue;
    let run = cache?.get(e.id) ?? null;
    if (!run) {
      run = await store.get(e.id).catch(() => null);
      if (run && cache) cache.set(e.id, run);
    }
    if (!run) continue;
    for (const r of run.results as EngineResult[]) {
      for (const f of r.findings) {
        (seenIn.get(f.fingerprint) ?? seenIn.set(f.fingerprint, new Set()).get(f.fingerprint))?.add(e.id);
        const g = groups.get(f.fingerprint);
        if (!g) {
          groups.set(f.fingerprint, {
            fingerprint: f.fingerprint,
            ...(f.ruleId ? { ruleId: f.ruleId } : {}),
            title: f.title,
            severity: f.severity,
            classification: f.classification,
            engine: f.engine,
            ...(whereOf(f) ? { where: whereOf(f) } : {}),
            firstSeen: e.createdAt,
            lastSeen: e.createdAt,
            runs: 0,
            open: false,
            lastRunId: e.id,
          });
        } else {
          g.firstSeen = e.createdAt; // walking newest → oldest
        }
      }
    }
  }
  for (const g of groups.values()) {
    const ids = seenIn.get(g.fingerprint) ?? new Set();
    g.runs = ids.size;
    g.open = ids.has(latestByEngine.get(g.engine) ?? "");
  }
  const rank = (s: Severity) => SEVERITIES.indexOf(s);
  const findings = [...groups.values()].sort(
    (a, b) =>
      Number(b.open) - Number(a.open) ||
      rank(a.severity) - rank(b.severity) ||
      b.lastSeen.localeCompare(a.lastSeen),
  );
  return { findings, scannedRuns: entries.length };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Health of every configured target: GET <url><health>, 2 s timeout, only hosts the safety config allows. */
export async function targetsHealth(world: World): Promise<TargetInfo[]> {
  const cfg = world.config.config;
  const allow = new Set((cfg.safety?.allowHosts ?? []).map((h) => h.toLowerCase()));
  return Promise.all(
    Object.entries(cfg.targets ?? {}).map(async ([name, t]): Promise<TargetInfo> => {
      const base: TargetInfo = { name, url: t.url, role: t.role, health: { ok: false, checked: false } };
      let u: URL;
      try {
        u = new URL(t.health ?? "/", t.url);
      } catch {
        return { ...base, health: { ok: false, checked: false, error: "invalid URL" } };
      }
      const host = u.hostname.toLowerCase();
      if (!LOOPBACK.has(host) && !allow.has(host))
        return {
          ...base,
          health: { ok: false, checked: false, error: "not checked (host not in safety.allowHosts)" },
        };
      if (!t.health && t.role === "dependency") return base;
      const t0 = performance.now();
      try {
        // undici's request() never follows redirects.
        const res = await request(u, { method: "GET", headersTimeout: 2000, bodyTimeout: 2000 });
        await res.body.dump();
        const ms = Math.round(performance.now() - t0);
        return { ...base, health: { ok: res.statusCode < 500, status: res.statusCode, ms, checked: true } };
      } catch (e) {
        const code = (e as { code?: string }).code;
        return {
          ...base,
          health: {
            ok: false,
            checked: true,
            error: code === "ECONNREFUSED" ? "not running (connection refused)" : (e as Error).message,
          },
        };
      }
    }),
  );
}
