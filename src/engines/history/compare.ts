/**
 * Baseline comparison, finding diff and trend anomaly detection.
 * See docs/03-engines/evidence-and-history.md §B.2, §A.3 (fingerprints) and
 * docs/04-data-structures-and-algorithms.md §6.2 (statistical comparison), §6.3 (CUSUM, robust z).
 */
import type { Finding } from "../../core/evidence/schemas.js";
import { createRng } from "../../core/rng.js";
import { cusum, mad } from "../../shared/stats/anomaly.js";
import { compareSamples, holm } from "../../shared/stats/compare.js";
import { median } from "../../shared/stats/quantile.js";
import { metricDirection } from "./metrics.js";
import type {
  FindingDiff,
  FindingDiffEntry,
  HistoryRun,
  MetricComparison,
  RunComparison,
  TrendPoint,
  TrendResult,
} from "./types.js";

/** Default metric family compared (kept small: Holm–Bonferroni costs power per extra metric). */
export const PRIMARY_METRICS =
  /^(performance\.http\.(p95|p99|error_rate|rps)|stress\.(tested_capacity|first_breach_level))$/;

export interface CompareRunsOptions {
  /** Metric names or a RegExp. Default PRIMARY_METRICS. */
  metrics?: readonly string[] | RegExp;
  alpha?: number;
  /** Bootstrap resamples (default 10,000). */
  B?: number;
  seed?: number;
  minRuns?: number;
  /** Single-run: |relative change| above which the point estimate is called worse/better. Default 0.10. */
  changeThreshold?: number;
  /** Holm–Bonferroni across the statistical metrics. Default true. */
  holm?: boolean;
  /** Fingerprints seen in runs before the baseline (to classify "regressed"). */
  priorFingerprints?: ReadonlySet<string>;
}

function samplesFor(runs: readonly HistoryRun[], metric: string): number[] {
  if (runs.length === 1) {
    const reps = runs[0]?.repetitions?.[metric];
    if (reps && reps.length >= 2) return [...reps];
  }
  const out: number[] = [];
  for (const r of runs) {
    const v = r.metrics[metric];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

const FINDING_GONE = new Set(["fixed", "false-positive"]);

/** Finding diff by fingerprint → new / fixed / regressed / unchanged. */
export function diffFindings(
  baseline: readonly Finding[],
  current: readonly Finding[],
  priorFingerprints: ReadonlySet<string> = new Set(),
): FindingDiff {
  const present = (fs: readonly Finding[]): Map<string, Finding> => {
    const m = new Map<string, Finding>();
    for (const f of fs) if (!FINDING_GONE.has(f.status)) m.set(f.fingerprint, f);
    return m;
  };
  const base = present(baseline);
  const baseFixed = new Set(baseline.filter((f) => FINDING_GONE.has(f.status)).map((f) => f.fingerprint));
  const cur = present(current);
  const entry = (
    status: FindingDiffEntry["status"],
    f: Finding,
    b?: Finding,
    c?: Finding,
  ): FindingDiffEntry => ({
    fingerprint: f.fingerprint,
    status,
    title: f.title,
    engine: f.engine,
    severity: f.severity,
    ...(b ? { baseline: b } : {}),
    ...(c ? { current: c } : {}),
  });
  const out: FindingDiff = { new: [], fixed: [], regressed: [], unchanged: [] };
  for (const [fp, f] of cur) {
    const b = base.get(fp);
    if (b) out.unchanged.push(entry("unchanged", f, b, f));
    else if (baseFixed.has(fp) || priorFingerprints.has(fp))
      out.regressed.push(entry("regressed", f, undefined, f));
    else out.new.push(entry("new", f, undefined, f));
  }
  for (const [fp, b] of base) if (!cur.has(fp)) out.fixed.push(entry("fixed", b, b));
  return out;
}

export function compareRuns(
  baseline: HistoryRun | readonly HistoryRun[],
  current: HistoryRun | readonly HistoryRun[],
  opts: CompareRunsOptions = {},
): RunComparison {
  const A = (Array.isArray(baseline) ? baseline : [baseline]) as readonly HistoryRun[];
  const Bn = (Array.isArray(current) ? current : [current]) as readonly HistoryRun[];
  const alpha = opts.alpha ?? 0.05;
  const thr = opts.changeThreshold ?? 0.1;
  const sel = opts.metrics ?? PRIMARY_METRICS;
  const names = new Set<string>();
  for (const r of [...A, ...Bn]) {
    for (const k of Object.keys(r.metrics)) names.add(k);
    for (const k of Object.keys(r.repetitions ?? {})) names.add(k);
  }
  const chosen = [...names].filter((n) => (sel instanceof RegExp ? sel.test(n) : sel.includes(n))).sort();
  const rng = createRng(opts.seed ?? 1);
  const metrics: MetricComparison[] = [];
  for (const metric of chosen) {
    const a = samplesFor(A, metric);
    const b = samplesFor(Bn, metric);
    if (a.length === 0 || b.length === 0) continue;
    const direction = metricDirection(metric);
    if (a.length >= 2 && b.length >= 2) {
      const mrng = rng.fork(metric);
      const r = compareSamples(a, b, {
        direction,
        rng: () => mrng.next(),
        alpha,
        ...(opts.B !== undefined ? { B: opts.B } : {}),
        ...(opts.minRuns !== undefined ? { minRuns: opts.minRuns } : {}),
      });
      metrics.push({
        metric,
        direction,
        method: "statistical",
        baseline: r.medians.baseline,
        current: r.medians.variant,
        relativeChange: r.relativeChange,
        verdict: r.verdict,
        ci95: [r.ci.lower, r.ci.upper],
        p: r.p,
        n: { baseline: r.n.baseline, current: r.n.variant },
        cliffsDelta: r.cliffsDelta.delta,
        note: r.reasons.join("; "),
      });
    } else {
      const base = median(a);
      const cur = median(b);
      const rel = base !== 0 ? (cur - base) / Math.abs(base) : cur - base;
      const worse = direction === "lower-is-better" ? rel > thr : rel < -thr;
      const better = direction === "lower-is-better" ? rel < -thr : rel > thr;
      metrics.push({
        metric,
        direction,
        method: "single-run",
        baseline: base,
        current: cur,
        relativeChange: rel,
        verdict: "inconclusive",
        movement: worse ? "worse" : better ? "better" : "within-threshold",
        n: { baseline: a.length, current: b.length },
        note: "single run per arm: no statistics (point values from HDR histogram percentiles); repeat runs (r ≥ 5) for a verdict",
      });
    }
  }
  // Holm–Bonferroni across statistical metrics.
  const stat = metrics.filter((m) => m.method === "statistical");
  if (opts.holm !== false && stat.length > 1) {
    const adj = holm(stat.map((m) => m.p ?? 1));
    stat.forEach((m, i) => {
      m.pAdjusted = adj[i] as number;
      if ((m.verdict === "regressed" || m.verdict === "improved") && m.pAdjusted >= alpha) {
        m.note = `${m.note ? `${m.note}; ` : ""}not significant after Holm adjustment (p_adj=${m.pAdjusted.toPrecision(3)})`;
        m.verdict = "inconclusive";
      }
    });
  } else if (stat.length === 1 && stat[0]) stat[0].pAdjusted = stat[0].p ?? 1;

  const prior = opts.priorFingerprints ?? new Set<string>();
  const findings = diffFindings(
    A.flatMap((r) => r.results.flatMap((x) => x.findings)),
    Bn.flatMap((r) => r.results.flatMap((x) => x.findings)),
    prior,
  );
  const regressions = metrics.filter((m) => m.verdict === "regressed").map((m) => m.metric);
  const worseUnverified = metrics.filter((m) => m.movement === "worse").map((m) => m.metric);
  const methods = new Set(metrics.map((m) => m.method));
  const method = methods.size > 1 ? "mixed" : methods.has("statistical") ? "statistical" : "single-run";
  const parts = [
    `${regressions.length} metric regression(s)${regressions.length ? `: ${regressions.join(", ")}` : ""}`,
    `findings: ${findings.new.length} new, ${findings.regressed.length} regressed, ${findings.fixed.length} fixed, ${findings.unchanged.length} unchanged`,
  ];
  if (worseUnverified.length > 0)
    parts.push(
      `${worseUnverified.length} metric(s) moved worse in a single-run comparison (no statistics): ${worseUnverified.join(", ")}`,
    );
  return {
    baselineIds: A.map((r) => r.id),
    currentIds: Bn.map((r) => r.id),
    method,
    metrics,
    findings,
    regressions,
    summary: parts.join("; "),
  };
}

export interface TrendOptions {
  /** Rolling reference window (points before the current one). Default 20. */
  window?: number;
  /** Points required before z-scores are computed. Default 5. */
  minWindow?: number;
  /** Robust |z| threshold. Default 3.5. */
  zThreshold?: number;
  cusum?: { k?: number; h?: number };
}

/**
 * Rolling median + MAD robust z-score (z = 0.6745·(x − median)/MAD over the preceding window) and
 * two-sided CUSUM change points over the whole series.
 */
export function trendAnalysis(
  metric: string,
  series: readonly { runId: string; createdAt: string; value: number }[],
  opts: TrendOptions = {},
): TrendResult {
  const w = opts.window ?? 20;
  const minW = opts.minWindow ?? 5;
  const zt = opts.zThreshold ?? 3.5;
  const values = series.map((p) => p.value);
  const points: TrendPoint[] = series.map((p, i) => {
    if (i < minW) return { ...p, z: null, anomaly: false };
    const ref = values.slice(Math.max(0, i - w), i);
    const med = median(ref);
    const m = mad(ref);
    if (m > 0) {
      const z = (0.6745 * (p.value - med)) / m;
      return { ...p, z, anomaly: Math.abs(z) > zt };
    }
    return { ...p, z: p.value === med ? 0 : null, anomaly: p.value !== med };
  });
  if (values.length >= minW) {
    const cs = cusum(values, {
      k: opts.cusum?.k ?? 0.5,
      h: opts.cusum?.h ?? 5,
      warmup: Math.min(values.length, Math.max(minW, w)),
    });
    for (const s of cs.signals) {
      const pt = points[s.index];
      if (pt) pt.changePoint = s.direction;
    }
  }
  return {
    metric,
    points,
    anomalies: points.filter((p) => p.anomaly),
    changePoints: points.filter((p) => p.changePoint !== undefined),
    method: `rolling median/MAD robust z (window ${w}, |z| > ${zt}); CUSUM k=${opts.cusum?.k ?? 0.5}, h=${opts.cusum?.h ?? 5}`,
  };
}
