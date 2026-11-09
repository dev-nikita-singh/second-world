/**
 * Reads the combined report (kind "second-world-report") for the run screen. Defensive: reports come from
 * history written by any SECOND WORLD version, so every field is optional here. No DOM.
 * Tested in tests/unit/ui/web/report.test.ts.
 */
import { fmtMs, fmtNumber, severityRank } from "./format.js";

export interface UiFinding {
  id: string;
  fingerprint: string;
  engine: string;
  ruleId?: string;
  title: string;
  description: string;
  severity: string;
  classification: string;
  confidence?: number;
  where?: string;
  locations: Array<{ file: string; line: number; symbol?: string }>;
  affected: string[];
  impact?: string;
  recommendation?: string;
  reproduction?: { steps: string[]; command?: string; seed?: number };
  /** Copy-paste commands (Bug Hunter reproductions). */
  curl: string[];
  evidence: Array<Record<string, unknown>>;
  occurrences?: number;
}

export interface UiLimitation {
  engine: string;
  code: string;
  message: string;
  impact: string;
}

export interface UiResult {
  engine: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  data: Record<string, unknown>;
}

export interface UiReport {
  status: string;
  verdict: { passed?: boolean; exitCode?: number; reasons: string[] };
  durationMs?: number;
  results: UiResult[];
  findings: UiFinding[];
  limitations: UiLimitation[];
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function parseReport(raw: unknown): UiReport {
  const r = obj(raw);
  const results: UiResult[] = [];
  const findings: UiFinding[] = [];
  const limitations: UiLimitation[] = [];
  for (const x of arr(r.results)) {
    const res = obj(x);
    const engine = str(res.engine) ?? "unknown";
    const data = obj(res.data);
    const startedAt = str(res.startedAt);
    const endedAt = str(res.endedAt);
    const durationMs =
      startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : undefined;
    results.push({
      engine,
      status: str(res.status) ?? "unknown",
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
      data,
    });
    const repro = obj(data.reproductions);
    for (const f of arr(res.findings)) {
      const fo = obj(f);
      const fingerprint = str(fo.fingerprint) ?? "";
      const locations = arr(fo.locations)
        .map(obj)
        .filter((l) => typeof l.file === "string")
        .map((l) => ({
          file: l.file as string,
          line: num(l.line) ?? 1,
          ...(str(l.symbol) ? { symbol: str(l.symbol) as string } : {}),
        }));
      const affected = arr(fo.affected).filter((a): a is string => typeof a === "string");
      const rp = obj(fo.reproduction);
      const curl = arr(obj(repro[fingerprint]).curl).filter((c): c is string => typeof c === "string");
      const loc = locations[0];
      const where = loc ? `${loc.file}:${loc.line}` : affected[0];
      findings.push({
        id: str(fo.id) ?? fingerprint,
        fingerprint,
        engine: str(fo.engine) ?? engine,
        ...(str(fo.ruleId) ? { ruleId: str(fo.ruleId) as string } : {}),
        title: str(fo.title) ?? "(untitled finding)",
        description: str(fo.description) ?? "",
        severity: str(fo.severity) ?? "info",
        classification: str(fo.classification) ?? "observation",
        ...(num(fo.confidence) !== undefined ? { confidence: num(fo.confidence) as number } : {}),
        ...(where ? { where } : {}),
        locations,
        affected,
        ...(str(fo.impact) ? { impact: str(fo.impact) as string } : {}),
        ...(str(fo.recommendation) ? { recommendation: str(fo.recommendation) as string } : {}),
        ...(Object.keys(rp).length
          ? {
              reproduction: {
                steps: arr(rp.steps).filter((s): s is string => typeof s === "string"),
                ...(str(rp.command) ? { command: str(rp.command) as string } : {}),
                ...(num(rp.seed) !== undefined ? { seed: num(rp.seed) as number } : {}),
              },
            }
          : {}),
        curl,
        evidence: arr(fo.evidence).map(obj),
        ...(num(fo.occurrences) !== undefined ? { occurrences: num(fo.occurrences) as number } : {}),
      });
    }
    for (const l of arr(res.limitations)) {
      const lo = obj(l);
      limitations.push({
        engine,
        code: str(lo.code) ?? "",
        message: str(lo.message) ?? "",
        impact: str(lo.impact) ?? "informational",
      });
    }
  }
  findings.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.title.localeCompare(b.title),
  );
  const v = obj(r.verdict);
  return {
    status: str(r.status) ?? results[0]?.status ?? "unknown",
    verdict: {
      ...(typeof v.passed === "boolean" ? { passed: v.passed } : {}),
      ...(num(v.exitCode) !== undefined ? { exitCode: num(v.exitCode) as number } : {}),
      reasons: arr(v.reasons).filter((x): x is string => typeof x === "string"),
    },
    ...(num(r.durationMs) !== undefined ? { durationMs: num(r.durationMs) as number } : {}),
    results,
    findings,
    limitations,
  };
}

export function countBySeverity(findings: ReadonlyArray<{ severity: string }>): Record<string, number> {
  const c: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) c[f.severity] = (c[f.severity] ?? 0) + 1;
  return c;
}

/** Performance / stress numbers for the summary tiles. */
export interface PerfView {
  requests?: number;
  failed?: number;
  rps?: number;
  errorRate?: number;
  p50?: number;
  p95?: number;
  p99?: number;
  max?: number;
  target?: string;
  endpoints: Array<{
    key: string;
    requests: number;
    rps?: number;
    errorRate?: number;
    p50?: number;
    p95?: number;
    p99?: number;
  }>;
  series: Array<{ t: number; p50?: number; p95?: number; rps?: number; failed?: number }>;
  thresholds: Array<{ expression: string; actual: number | null; passed: boolean; unit?: string }>;
}

export function perfView(data: Record<string, unknown>): PerfView | null {
  const totals = obj(data.totals);
  if (num(totals.requests) === undefined) return null;
  const lat = obj(obj(data.latency).corrected);
  return {
    requests: num(totals.requests),
    failed: num(totals.failed),
    rps: num(totals.rps),
    errorRate: num(totals.errorRate),
    p50: num(lat.p50),
    p95: num(lat.p95),
    p99: num(lat.p99),
    max: num(lat.max),
    ...(str(data.target) ? { target: str(data.target) as string } : {}),
    endpoints: arr(data.endpoints).map((e) => {
      const eo = obj(e);
      const l = obj(obj(eo.latency).corrected);
      return {
        key: str(eo.key) ?? "?",
        requests: num(eo.requests) ?? 0,
        rps: num(eo.rps),
        errorRate: num(eo.errorRate),
        p50: num(l.p50),
        p95: num(l.p95),
        p99: num(l.p99),
      };
    }),
    series: arr(data.series).map((s) => {
      const so = obj(s);
      return {
        t: num(so.t) ?? 0,
        p50: num(so.p50),
        p95: num(so.p95),
        rps: num(so.rps),
        failed: num(so.failed),
      };
    }),
    thresholds: arr(data.thresholds).map((t) => {
      const to = obj(t);
      return {
        expression: str(to.expression) ?? "",
        actual: num(to.actual) ?? null,
        passed: to.passed === true,
        ...(str(to.unit) ? { unit: str(to.unit) as string } : {}),
      };
    }),
  };
}

export interface StressView {
  statement: string;
  testedCapacity: number | null;
  loadType: string;
  firstBreach?: string;
  stages: Array<{
    label: string;
    level: number;
    status: string;
    throughput?: number;
    errorRate?: number;
    p95?: number;
    breach: string[];
  }>;
}

export function stressView(data: Record<string, unknown>): StressView | null {
  if (!Array.isArray(data.stages)) return null;
  const cap = obj(data.capacity);
  const fb = obj(data.firstBreach);
  return {
    statement: str(cap.statement) ?? "",
    testedCapacity: num(cap.testedCapacity) ?? null,
    loadType: str(data.loadType) ?? "vus",
    ...(str(fb.expression) ? { firstBreach: `${str(fb.expression)} at level ${num(fb.level) ?? "?"}` } : {}),
    stages: arr(data.stages).map((s) => {
      const so = obj(s);
      const lat = obj(obj(so.latency).corrected);
      return {
        label: str(so.label) ?? String(num(so.level) ?? ""),
        level: num(so.level) ?? 0,
        status: str(so.status) ?? "",
        throughput: num(so.throughput),
        errorRate: num(so.errorRate),
        p95: num(lat.p95) ?? num(so.p95),
        breach: arr(so.breachReasons).filter((b): b is string => typeof b === "string"),
      };
    }),
  };
}

/** Top-level scalar facts of an engine payload ("mode", "target", "verdict"…), for a details list. */
export function scalarFacts(data: Record<string, unknown>, limit = 12): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(data)) {
    if (out.length >= limit) break;
    if (typeof v === "string" && v.length <= 120) out.push([k, v]);
    else if (typeof v === "number" && /Ms$/.test(k)) out.push([k.replace(/Ms$/, ""), fmtMs(v)]);
    else if (typeof v === "number") out.push([k, fmtNumber(v)]);
    else if (typeof v === "boolean") out.push([k, v ? "yes" : "no"]);
  }
  return out;
}

/** Diff of two runs' headline metrics (for the compare screen). */
export function metricRows(
  cmp: unknown,
): Array<{ metric: string; baseline?: number; current?: number; change?: number; verdict?: string }> {
  const c = obj(cmp);
  const rows: Array<{
    metric: string;
    baseline?: number;
    current?: number;
    change?: number;
    verdict?: string;
  }> = [];
  for (const m of arr(c.metrics ?? c.comparisons)) {
    const mo = obj(m);
    const metric = str(mo.metric) ?? str(mo.name);
    if (!metric) continue;
    rows.push({
      metric,
      ...(num(mo.baseline) !== undefined ? { baseline: num(mo.baseline) as number } : {}),
      ...(num(mo.current) !== undefined ? { current: num(mo.current) as number } : {}),
      ...(num(mo.relativeChange ?? mo.change) !== undefined
        ? { change: num(mo.relativeChange ?? mo.change) as number }
        : {}),
      ...(str(mo.verdict) ? { verdict: str(mo.verdict) as string } : {}),
    });
  }
  return rows;
}
