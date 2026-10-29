/**
 * Reliability Lab measurements & detectors (pure functions). See docs/03-engines/reliability-lab.md §3,
 * docs/04-data-structures-and-algorithms.md §3.6 (backoff + full jitter), §3.7 (circuit breaker FSM),
 * §4.4 (1 s windows).
 *
 * Inputs are per-request client records (from the workload) and proxy arrival timestamps (from the
 * built-in proxy), all in the same monotonic clock (ms).
 */
import { quantile } from "../../shared/stats/quantile.js";

export interface ReqRecord {
  route: string;
  /** Clock ms when sent. */
  start: number;
  /** Clock ms when finished (response body consumed or error). */
  end: number;
  /** HTTP status, 0 on transport failure. */
  status: number;
  /** Transport error kind ("timeout", "econnreset", ...). */
  error?: string;
}

/** Reliability failure: transport error or 5xx (4xx are application answers, not dependency failures). */
export function isFailure(r: ReqRecord): boolean {
  return r.status === 0 || r.status >= 500;
}

export function isTimeout(r: ReqRecord): boolean {
  return r.status === 0 && r.error === "timeout";
}

export interface PhaseStats {
  requests: number;
  errors: number;
  timeouts: number;
  errorRate: number;
  timeoutRate: number;
  /** Latency (ms), nearest-rank. NaN when no requests. */
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  max: number;
  rps: number;
}

function pct(sorted: Float64Array, q: number): number {
  return sorted.length === 0 ? Number.NaN : quantile(sorted, q, "nearest-rank");
}

/** Stats over records STARTED in [from, to). */
export function phaseStats(
  records: readonly ReqRecord[],
  from: number,
  to: number,
  route?: string,
): PhaseStats {
  const lat: number[] = [];
  let errors = 0;
  let timeouts = 0;
  let sum = 0;
  for (const r of records) {
    if (r.start < from || r.start >= to) continue;
    if (route !== undefined && r.route !== route) continue;
    const l = r.end - r.start;
    lat.push(l);
    sum += l;
    if (isFailure(r)) errors++;
    if (isTimeout(r)) timeouts++;
  }
  const sorted = Float64Array.from(lat).sort();
  const n = lat.length;
  return {
    requests: n,
    errors,
    timeouts,
    errorRate: n ? errors / n : 0,
    timeoutRate: n ? timeouts / n : 0,
    p50: pct(sorted, 0.5),
    p95: pct(sorted, 0.95),
    p99: pct(sorted, 0.99),
    avg: n ? sum / n : Number.NaN,
    max: n ? (sorted[n - 1] as number) : Number.NaN,
    rps: to > from ? n / ((to - from) / 1000) : 0,
  };
}

/** Value of a threshold stat ("p95", "error_rate", ...) from PhaseStats. */
export function statValue(
  s: PhaseStats,
  stat: string,
  percentile?: number,
  records?: readonly ReqRecord[],
): number {
  switch (stat) {
    case "p50":
    case "med":
      return s.p50;
    case "p95":
      return s.p95;
    case "p99":
      return s.p99;
    case "avg":
      return s.avg;
    case "max":
      return s.max;
    case "error_rate":
      return s.errorRate;
    case "timeout_rate":
      return s.timeoutRate;
    case "success_rate":
      return 1 - s.errorRate;
    case "rps":
      return s.rps;
    case "count":
    case "requests":
      return s.requests;
    case "errors":
      return s.errors;
    case "timeouts":
      return s.timeouts;
    default:
      if (percentile !== undefined && records) {
        const sorted = Float64Array.from(records.map((r) => r.end - r.start)).sort();
        return pct(sorted, percentile / 100);
      }
      return Number.NaN;
  }
}

export interface WindowStat {
  /** Window start relative to the reference time (ms). */
  tMs: number;
  requests: number;
  errors: number;
  timeouts: number;
  errorRate: number;
  p50: number;
  p95: number;
  /** Proxy arrivals (dependency calls) in the window, null when not counted. */
  proxy: number | null;
}

/** 1 s windows by request start time over [t0, t1), relative to `ref` (default t0). */
export function windowize(
  records: readonly ReqRecord[],
  arrivals: readonly number[] | null,
  t0: number,
  t1: number,
  opts: { windowMs?: number; ref?: number; routes?: ReadonlySet<string> } = {},
): WindowStat[] {
  const w = opts.windowMs ?? 1000;
  const n = Math.max(0, Math.ceil((t1 - t0) / w));
  const lats: number[][] = Array.from({ length: n }, () => []);
  const errs = new Array<number>(n).fill(0);
  const tos = new Array<number>(n).fill(0);
  const prox = new Array<number>(n).fill(0);
  for (const r of records) {
    if (r.start < t0 || r.start >= t1) continue;
    if (opts.routes && !opts.routes.has(r.route)) continue;
    const i = Math.floor((r.start - t0) / w);
    (lats[i] as number[]).push(r.end - r.start);
    if (isFailure(r)) errs[i] = (errs[i] as number) + 1;
    if (isTimeout(r)) tos[i] = (tos[i] as number) + 1;
  }
  if (arrivals) {
    for (const a of arrivals) {
      if (a < t0 || a >= t1) continue;
      const i = Math.floor((a - t0) / w);
      prox[i] = (prox[i] as number) + 1;
    }
  }
  const ref = opts.ref ?? t0;
  const out: WindowStat[] = [];
  for (let i = 0; i < n; i++) {
    const l = Float64Array.from(lats[i] as number[]).sort();
    const c = l.length;
    out.push({
      tMs: Math.round(t0 + i * w - ref),
      requests: c,
      errors: errs[i] as number,
      timeouts: tos[i] as number,
      errorRate: c ? (errs[i] as number) / c : 0,
      p50: pct(l, 0.5),
      p95: pct(l, 0.95),
      proxy: arrivals ? (prox[i] as number) : null,
    });
  }
  return out;
}

export interface RecoveryBounds {
  p95Ms: number;
  errorRate: number;
}

export interface RecoveryResult {
  recovered: boolean;
  /** ms from revert to the start of the first of `consecutive` in-bounds windows; null if never. */
  recoveryMs: number | null;
  bounds: RecoveryBounds;
  consecutive: number;
}

/**
 * Recovery time (MTTR-like): first window after revert from which `consecutive` (default 3)
 * windows with traffic all have p95 and error rate within the steady-state bounds.
 * Windows without requests are neutral (neither break nor count). `windows` must start at the revert.
 */
export function recoveryTime(
  windows: readonly WindowStat[],
  bounds: RecoveryBounds,
  consecutive = 3,
  windowMs = 1000,
): RecoveryResult {
  let runStart = -1;
  let run = 0;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i] as WindowStat;
    if (w.requests === 0) continue;
    const ok = w.errorRate <= bounds.errorRate && !(w.p95 > bounds.p95Ms);
    if (ok) {
      if (run === 0) runStart = i;
      run++;
      if (run >= consecutive)
        return { recovered: true, recoveryMs: runStart * windowMs, bounds, consecutive };
    } else {
      run = 0;
      runStart = -1;
    }
  }
  return { recovered: false, recoveryMs: null, bounds, consecutive };
}

/** Default steady-state bounds from steady stats (+ explicit thresholds when given). */
export function deriveBounds(
  steady: PhaseStats,
  explicit: { p95Ms?: number; errorRate?: number } = {},
): RecoveryBounds {
  const p95 = Number.isFinite(steady.p95) ? steady.p95 : 0;
  return {
    p95Ms: explicit.p95Ms ?? Math.max(2 * p95, p95 + 50),
    errorRate: explicit.errorRate ?? Math.max(0.05, steady.errorRate + 0.05),
  };
}

// ---------------------------------------------------------------- retry amplification

export interface Amplification {
  /** Dependency calls per client request during the fault. */
  faultRatio: number;
  /** Same during steady state (baseline, ≈ calls per request when healthy). */
  steadyRatio: number | null;
  /** faultRatio / steadyRatio (or faultRatio when no baseline). */
  factor: number;
  proxyRequests: number;
  clientRequests: number;
  storm: boolean;
}

function countIn(times: readonly number[], from: number, to: number): number {
  let n = 0;
  for (const t of times) if (t >= from && t < to) n++;
  return n;
}

export function amplification(
  arrivals: readonly number[],
  records: readonly ReqRecord[],
  steady: { from: number; to: number },
  fault: { from: number; to: number },
  routes?: ReadonlySet<string>,
  stormFactor = 3,
  minBaseline = 10,
): Amplification {
  const clients = (from: number, to: number): number => {
    let n = 0;
    for (const r of records) if (r.start >= from && r.start < to && (!routes || routes.has(r.route))) n++;
    return n;
  };
  const sc = clients(steady.from, steady.to);
  const sp = countIn(arrivals, steady.from, steady.to);
  const fc = clients(fault.from, fault.to);
  const fp = countIn(arrivals, fault.from, fault.to);
  // A baseline from < minBaseline requests is too noisy (edge effects): fall back to the raw ratio.
  const steadyRatio = sc >= minBaseline && sp > 0 ? sp / sc : null;
  const faultRatio = fc > 0 ? fp / fc : 0;
  const factor = steadyRatio ? faultRatio / steadyRatio : faultRatio;
  return {
    faultRatio,
    steadyRatio,
    factor,
    proxyRequests: fp,
    clientRequests: fc,
    storm: factor > stormFactor,
  };
}

// ---------------------------------------------------------------- synchronised retries (missing jitter)

export interface LagHistogram {
  binMs: number;
  minLagMs: number;
  counts: number[];
  pairs: number;
}

/**
 * Histogram of positive pairwise lags t_j − t_i in [minLagMs, maxLagMs) between arrivals: the
 * (unnormalised) autocorrelation of the arrival point process. Poisson traffic gives a flat histogram;
 * constant-delay retries give sharp peaks at the retry delay. O(n·k), pairs capped.
 */
export function lagHistogram(
  timesIn: readonly number[],
  opts: { binMs?: number; minLagMs?: number; maxLagMs?: number; maxPairs?: number } = {},
): LagHistogram {
  const binMs = opts.binMs ?? 5;
  const minLag = opts.minLagMs ?? 10;
  const maxLag = opts.maxLagMs ?? 1000;
  const maxPairs = opts.maxPairs ?? 5_000_000;
  const times = Float64Array.from(timesIn).sort();
  const nb = Math.max(1, Math.ceil((maxLag - minLag) / binMs));
  const counts = new Array<number>(nb).fill(0);
  let pairs = 0;
  outer: for (let i = 0; i < times.length; i++) {
    const ti = times[i] as number;
    for (let j = i + 1; j < times.length; j++) {
      const d = (times[j] as number) - ti;
      if (d >= maxLag) break;
      if (d < minLag) continue;
      const b = Math.floor((d - minLag) / binMs);
      counts[b] = (counts[b] as number) + 1;
      if (++pairs >= maxPairs) break outer;
    }
  }
  return { binMs, minLagMs: minLag, counts, pairs };
}

export interface SyncRetryResult {
  detected: boolean;
  /** Lag (ms) of the strongest peak (≈ retry delay + dependency response time). */
  lagMs: number | null;
  /** Peak count (two adjacent bins) vs robust background. */
  peak: number;
  background: number;
  z: number;
  ratio: number;
  arrivals: number;
  /** Same statistic on the control (steady-state) arrivals, if given. */
  controlZ: number | null;
  reason: string;
}

/**
 * Strongest 4-bin (20 ms) peak vs a high-quantile background. The background is the 90th percentile of all
 * 4-bin sums, not the median: timer quantisation (≈15.6 ms ticks on Windows) makes setTimeout-driven
 * retries arrive on a lattice, which produces a peak at EVERY tick multiple. Those repeated peaks set
 * the p90, while synchronised retries add a few isolated peaks (lags D, 2D, 3D) that stand above it.
 */
function strongestPeak(h: LagHistogram): {
  idx: number;
  peak: number;
  background: number;
  z: number;
  ratio: number;
} {
  const c = h.counts;
  // Peak window = 4 bins (20 ms at 5 ms bins): a constant retry delay is smeared by up to one timer tick.
  const W = 4;
  const sums: number[] = [];
  for (let i = 0; i + W <= c.length; i++) {
    let v = 0;
    for (let k = 0; k < W; k++) v += c[i + k] as number;
    sums.push(v);
  }
  const sorted = [...sums].sort((a, b) => a - b);
  const p90 = sorted.length
    ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] as number)
    : 0;
  const bg = Math.max(p90, 0.5);
  let best = { idx: -1, peak: 0, background: bg, z: 0, ratio: 0 };
  for (let i = 0; i < sums.length; i++) {
    const p = sums[i] as number;
    if (p > best.peak)
      best = { idx: i, peak: p, background: bg, z: (p - bg) / Math.sqrt(bg + 1), ratio: p / bg };
  }
  return best;
}

/**
 * Detects synchronised retries (no jitter) from dependency arrival times during the fault.
 * Detected when the strongest lag peak has z ≥ zMin (default 5) and ≥ ratioMin× (1.25) the background
 * (p90 of 4-bin sums, see strongestPeak) and ≥ minPeak pairs, and the control (steady-state) arrivals show no comparable peak at
 * the same lag (workload periodicity). The background grows with rate², so the ratio stays modest at high
 * traffic while z grows; z is the primary criterion.
 */
export function detectSynchronizedRetries(
  faultArrivals: readonly number[],
  controlArrivals: readonly number[] | null = null,
  opts: {
    binMs?: number;
    minLagMs?: number;
    maxLagMs?: number;
    zMin?: number;
    ratioMin?: number;
    minPeak?: number;
  } = {},
): SyncRetryResult {
  const zMin = opts.zMin ?? 5;
  const ratioMin = opts.ratioMin ?? 1.25;
  const minPeak = opts.minPeak ?? 8;
  const h = lagHistogram(faultArrivals, opts);
  const p = strongestPeak(h);
  const lagMs = p.idx >= 0 ? h.minLagMs + (p.idx + 2) * h.binMs : null;
  // Control: the same statistic at the SAME lag on steady-state arrivals (workload periodicity check).
  let controlZ: number | null = null;
  let controlExcess = 0;
  if (controlArrivals && controlArrivals.length >= 10 && p.idx >= 0) {
    const hc = lagHistogram(controlArrivals, opts);
    let at = 0;
    for (let k = 0; k < 4; k++) at += hc.counts[p.idx + k] ?? 0;
    const bgc = strongestPeak(hc).background;
    controlZ = (at - bgc) / Math.sqrt(bgc + 1);
    // excess pairs per arrival (scale-free: the control window is usually shorter than the fault)
    controlExcess = (at - bgc) / controlArrivals.length;
  }
  const base = {
    lagMs,
    peak: p.peak,
    background: p.background,
    z: p.z,
    ratio: p.ratio,
    arrivals: faultArrivals.length,
    controlZ,
  };
  if (faultArrivals.length < 10) return { ...base, detected: false, reason: "too few dependency calls" };
  if (p.peak < minPeak || p.z < zMin || p.ratio < ratioMin) {
    return { ...base, detected: false, reason: "no synchronised lag peak (arrivals look jittered/random)" };
  }
  if (
    controlZ !== null &&
    controlZ >= zMin / 2 &&
    controlExcess >= (0.5 * (p.peak - p.background)) / faultArrivals.length
  ) {
    return {
      ...base,
      detected: false,
      reason: "steady-state traffic shows the same periodicity (workload, not retries)",
    };
  }
  return {
    ...base,
    detected: true,
    reason: `dependency calls cluster at a fixed lag of ~${lagMs} ms (z=${p.z.toFixed(1)})`,
  };
}

// ---------------------------------------------------------------- circuit breaker

export interface BreakerResult {
  verdict: "breaker-detected" | "no-breaker" | "inconclusive";
  /** Dependency calls per client request, baseline / early fault / late fault. */
  baselineRatio: number | null;
  earlyRatio: number | null;
  lateRatio: number | null;
  /** Client p50 latency (ms) early vs late in the fault. */
  earlyP50: number | null;
  lateP50: number | null;
  lateErrorRate: number | null;
  /** Median gap between dependency calls while open (half-open probes), ms. */
  probeIntervalMs: number | null;
  reason: string;
}

/**
 * Circuit breaker detection during a sustained failure: an open breaker stops calling the dependency
 * (late calls/request ≪ baseline) and fails fast (late latency ≪ early). No breaker: the dependency is
 * still called ≥ 0.8× baseline per request in the second half of the fault while clients see failures.
 * `windows` = 1 s windows covering the fault only.
 */
export function detectCircuitBreaker(
  windows: readonly WindowStat[],
  baselineRatio: number | null,
  lateArrivals: readonly number[] = [],
  opts: { minFailures?: number } = {},
): BreakerResult {
  const empty: BreakerResult = {
    verdict: "inconclusive",
    baselineRatio,
    earlyRatio: null,
    lateRatio: null,
    earlyP50: null,
    lateP50: null,
    lateErrorRate: null,
    probeIntervalMs: null,
    reason: "",
  };
  if (windows.length < 3 || windows.some((w) => w.proxy === null)) {
    return { ...empty, reason: "fault too short (< 3 s) or dependency calls not counted" };
  }
  const sum = (ws: readonly WindowStat[], f: (w: WindowStat) => number): number =>
    ws.reduce((a, w) => a + f(w), 0);
  const early = windows.slice(0, 1);
  const late = windows.slice(Math.floor(windows.length / 2));
  const eReq = sum(early, (w) => w.requests);
  const lReq = sum(late, (w) => w.requests);
  const failures = sum(windows, (w) => w.errors);
  if (lReq < 3 || eReq < 1) return { ...empty, reason: "not enough client requests during the fault" };
  const earlyRatio = sum(early, (w) => w.proxy ?? 0) / eReq;
  const lateRatio = sum(late, (w) => w.proxy ?? 0) / lReq;
  const lateErrors = sum(late, (w) => w.errors);
  const lateErrorRate = lateErrors / lReq;
  const p50s = (ws: readonly WindowStat[]): number | null => {
    const v = ws
      .map((w) => w.p50)
      .filter((x) => Number.isFinite(x))
      .sort((a, b) => a - b);
    return v.length ? (v[Math.floor(v.length / 2)] as number) : null;
  };
  const earlyP50 = p50s(early);
  const lateP50 = p50s(late);
  const sortedLate = [...lateArrivals].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sortedLate.length; i++)
    gaps.push((sortedLate[i] as number) - (sortedLate[i - 1] as number));
  gaps.sort((a, b) => a - b);
  const probeIntervalMs = gaps.length ? (gaps[Math.floor(gaps.length / 2)] as number) : null;
  const base = { baselineRatio, earlyRatio, lateRatio, earlyP50, lateP50, lateErrorRate, probeIntervalMs };
  const ref = baselineRatio ?? earlyRatio;
  if (failures < (opts.minFailures ?? 5) && lateErrorRate < 0.5) {
    return { ...base, verdict: "inconclusive", reason: "the fault did not cause client-visible failures" };
  }
  if (ref > 0 && lateRatio <= 0.5 * ref) {
    return {
      ...base,
      verdict: "breaker-detected",
      reason: `dependency calls dropped to ${lateRatio.toFixed(2)}/request (baseline ${ref.toFixed(2)}): requests fail fast without calling it`,
    };
  }
  if (ref > 0 && lateRatio >= 0.8 * ref && lateErrorRate >= 0.5) {
    return {
      ...base,
      verdict: "no-breaker",
      reason: `still ${lateRatio.toFixed(2)} dependency calls per request after ${failures} client-visible failures`,
    };
  }
  return { ...base, verdict: "inconclusive", reason: "dependency call rate changed but not decisively" };
}

// ---------------------------------------------------------------- timeout correctness

export interface TimeoutAssessment {
  verdict: "no-timeout" | "timeout" | "inconclusive";
  /** Requests started ≥ minWaitMs before the revert. */
  eligible: number;
  /** Of those, answered (success or failure) before the revert. */
  completedDuringFault: number;
  /** Median client latency of requests answered during the fault (≈ effective timeout). */
  effectiveTimeoutMs: number | null;
  /** Share of stuck requests released at the revert (|end − revert| < tolerance) or timed out client-side. */
  trackingFraction: number;
  medianLatencyMs: number | null;
  /** Longest time a stuck request was observed waiting (client timeout / revert cap it). */
  longestWaitMs: number | null;
  /** Outbound timeout budget (timeout × attempts + backoff) that a "no timeout" verdict must exceed. */
  budgetMs: number;
  /**
   * True when nothing was answered during the black-hole but no request could be observed for longer
   * than `budgetMs` (client timeout or fault too short): a long timeout chain cannot be ruled out.
   */
  windowTooShort: boolean;
  reason: string;
}

/** Default `maxOutboundBudget`: longest plausible outbound timeout chain (timeout × attempts + backoff). */
export const DEFAULT_OUTBOUND_BUDGET_MS = 30_000;
/** Stuck requests that must have waited ≥ the budget for a "no timeout" verdict. */
const MIN_LONG_WAITS = 3;

/**
 * Timeout correctness while the dependency is black-holed: with an outbound timeout, requests are
 * answered during the fault (latency ≈ timeout·attempts). Without one, nothing is answered before the
 * revert: client latency tracks the black-hole (released at the revert) or the client's own timeout.
 */
export function assessTimeout(
  records: readonly ReqRecord[],
  faultFrom: number,
  faultTo: number,
  opts: { minWaitMs?: number; toleranceMs?: number; routes?: ReadonlySet<string>; budgetMs?: number } = {},
): TimeoutAssessment {
  const minWait = opts.minWaitMs ?? 1000;
  const budget = opts.budgetMs ?? DEFAULT_OUTBOUND_BUDGET_MS;
  const tol = opts.toleranceMs ?? 750;
  const eligible = records.filter(
    (r) => r.start >= faultFrom && r.start < faultTo - minWait && (!opts.routes || opts.routes.has(r.route)),
  );
  const answered = eligible.filter((r) => r.end < faultTo - 20 && !isTimeout(r));
  const stuck = eligible.filter((r) => !(r.end < faultTo - 20 && !isTimeout(r)));
  const tracking = stuck.filter((r) => isTimeout(r) || Math.abs(r.end - faultTo) < tol).length;
  const lat = (rs: readonly ReqRecord[]): number | null => {
    const v = rs.map((r) => r.end - r.start).sort((a, b) => a - b);
    return v.length ? (v[Math.floor(v.length / 2)] as number) : null;
  };
  let longest: number | null = null;
  let longWaits = 0;
  for (const r of stuck) {
    const w = r.end - r.start;
    longest = longest === null ? w : Math.max(longest, w);
    if (w >= budget) longWaits++;
  }
  const base = {
    eligible: eligible.length,
    completedDuringFault: answered.length,
    effectiveTimeoutMs: lat(answered),
    trackingFraction: stuck.length ? tracking / stuck.length : 0,
    medianLatencyMs: lat(eligible),
    longestWaitMs: longest,
    budgetMs: budget,
    windowTooShort: false,
  };
  if (eligible.length < 3)
    return { ...base, verdict: "inconclusive", reason: "too few requests during the black-hole" };
  if (answered.length === 0 && base.trackingFraction >= 0.8) {
    // Nothing answered can mean "no timeout" OR "a timeout chain longer than we could watch":
    // only requests that waited longer than the plausible budget tell them apart.
    if (longWaits < MIN_LONG_WAITS)
      return {
        ...base,
        verdict: "inconclusive",
        windowTooShort: true,
        reason: `no request was answered during the black-hole, but the longest observed wait was ${Math.round(longest ?? 0)} ms < the outbound timeout budget ${budget} ms (client timeout or fault too short): a timeout chain longer than the observable window cannot be ruled out`,
      };
    return {
      ...base,
      verdict: "no-timeout",
      reason: `no request was answered while the dependency was black-holed; latency tracked the black-hole duration (${longWaits} request(s) waited ≥ the ${budget} ms budget)`,
    };
  }
  if (answered.length / eligible.length >= 0.1) {
    return {
      ...base,
      verdict: "timeout",
      reason: `requests answered during the black-hole after ~${Math.round(base.effectiveTimeoutMs ?? 0)} ms`,
    };
  }
  return {
    ...base,
    verdict: "inconclusive",
    reason: "few requests answered during the black-hole (fault shorter than the timeout chain?)",
  };
}

// ---------------------------------------------------------------- isolation

export interface IsolationResult {
  route: string;
  related: boolean | null;
  steady: PhaseStats;
  fault: PhaseStats;
  degraded: boolean;
  isolationFailure: boolean;
  reason: string;
}

/**
 * Error propagation: compares per-route fault stats with steady state. A route that does not depend
 * on the faulted dependency (per config `dependsOn`, later the System Model) but degrades is an
 * isolation failure.
 */
export function assessIsolation(
  routes: readonly { name: string; dependsOn?: readonly string[] | undefined }[],
  dependency: string,
  steadyOf: (route: string) => PhaseStats,
  faultOf: (route: string) => PhaseStats,
): IsolationResult[] {
  return routes.map((rt) => {
    const steady = steadyOf(rt.name);
    const fault = faultOf(rt.name);
    const related = rt.dependsOn === undefined ? null : rt.dependsOn.includes(dependency);
    const sp95 = Number.isFinite(steady.p95) ? steady.p95 : 0;
    const errUp = fault.errorRate - steady.errorRate;
    const latUp = Number.isFinite(fault.p95) && fault.p95 > Math.max(2 * sp95, sp95 + 100);
    const degraded = fault.requests > 0 && (errUp > 0.05 || latUp);
    const reason = degraded
      ? `error rate ${(steady.errorRate * 100).toFixed(1)}% → ${(fault.errorRate * 100).toFixed(1)}%, p95 ${sp95.toFixed(0)} → ${Number.isFinite(fault.p95) ? fault.p95.toFixed(0) : "n/a"} ms`
      : "within steady-state behaviour";
    return {
      route: rt.name,
      related,
      steady,
      fault,
      degraded,
      isolationFailure: related === false && degraded,
      reason,
    };
  });
}
