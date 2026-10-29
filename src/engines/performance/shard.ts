/**
 * worker_threads sharding: pure helpers. See docs/03-engines/performance-lab.md §7 (scaling the
 * generator) and docs/04-data-structures-and-algorithms.md §4.1 (HDR histograms are mergeable).
 *
 * - Worker count: `workers: N | "auto"`, auto = min(availableParallelism() − 1, 8), at least 1.
 * - Load split: open rate/N with interleaved phases (see scheduler/open.ts `shard`), closed VUs and
 *   iterations split as evenly as possible (the remainder goes to the lowest indices).
 * - Seeds: worker k gets an independent stream derived from the run seed and k.
 * - Metrics travel as JSON snapshots with base64 HDR histograms; the merge is a bucket-wise HDR add
 *   (exact, never an average of percentiles). CO correction already happened in each worker.
 */
import os from "node:os";
import { createRng } from "../../core/rng.js";
import { LatencyHistogram, type LatencySummary } from "../../shared/stats/hdr.js";
import type { WindowLite } from "./engine.js";
import { type ErrorSample, type LatencyPair, PerfMetrics, PhaseStats } from "./metrics.js";
import type { PerformanceInput } from "./schema.js";

export const MAX_AUTO_WORKERS = 8;

/** The load-shape fields sharding looks at. */
export interface LoadShape {
  model: PerformanceInput["model"];
  vus?: number | undefined;
  iterations?: number | undefined;
  rate?: number | undefined;
}

/** `workers` → thread count. "auto" = min(availableParallelism − 1, 8), never below 1. */
export function resolveWorkers(
  workers: PerformanceInput["workers"] | undefined,
  parallelism: number = os.availableParallelism(),
): number {
  if (workers === undefined) return 1;
  if (workers === "auto") return Math.max(1, Math.min(Math.floor(parallelism) - 1, MAX_AUTO_WORKERS));
  return Math.max(1, Math.floor(workers));
}

/** Workers that can actually get load: never more than VUs (closed) or VUs/iterations (iterations). */
export function effectiveWorkers(input: LoadShape, requested: number): number {
  let n = Math.max(1, Math.floor(requested));
  if (input.model === "closed") n = Math.min(n, input.vus ?? 10);
  if (input.model === "iterations")
    n = Math.min(n, input.vus ?? 10, input.iterations ?? Number.POSITIVE_INFINITY);
  return Math.max(1, n);
}

/** Splits `total` into `n` integer parts differing by at most 1 (larger parts first). */
export function splitEven(total: number, n: number): number[] {
  const parts = Math.max(1, Math.floor(n));
  const t = Math.max(0, Math.floor(total));
  const base = Math.floor(t / parts);
  const rem = t - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rem ? 1 : 0));
}

/** Seed of worker `index`: an independent stream derived from the run seed (deterministic). */
export function deriveWorkerSeed(runSeed: number, index: number): number {
  return createRng(runSeed).fork(`perf-worker:${index}`).seed;
}

export interface ShardPlan {
  index: number;
  count: number;
  /** Closed/iterations: this worker's VUs. */
  vus?: number;
  /** Iterations model: this worker's iterations. */
  iterations?: number;
  /** Open model: this worker's in-flight cap. */
  maxInFlight: number;
  connections: number;
  /** Closed/iterations: this worker's GCRA rate (cap / N), null = no cap. */
  rpsCap: number | null;
  /** Share of the remaining request budget (+∞ = unlimited). */
  requestQuota: number;
  seed: number;
}

export interface ShardTotals {
  maxInFlight: number;
  connections: number;
  rpsCap: number | null;
  /** Remaining request budget of the lease (+∞ when unbounded). */
  requestBudget: number;
  runSeed: number;
}

export function planShards(input: LoadShape, n: number, t: ShardTotals): ShardPlan[] {
  const count = Math.max(1, Math.floor(n));
  const vus = input.model === "open" ? null : splitEven(input.vus ?? 10, count);
  const iters = input.model === "iterations" ? splitEven(input.iterations ?? 0, count) : null;
  const mif = splitEven(t.maxInFlight, count);
  const conns = splitEven(t.connections, count);
  const quota = Number.isFinite(t.requestBudget) ? splitEven(t.requestBudget, count) : null;
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    count,
    ...(vus ? { vus: vus[i] as number } : {}),
    ...(iters ? { iterations: iters[i] as number } : {}),
    maxInFlight: Math.max(1, mif[i] as number),
    connections: Math.max(1, conns[i] as number),
    rpsCap: t.rpsCap !== null && t.rpsCap > 0 ? t.rpsCap / count : null,
    requestQuota: quota ? (quota[i] as number) : Number.POSITIVE_INFINITY,
    seed: deriveWorkerSeed(t.runSeed, i),
  }));
}

// ------------------------------------------------------------------ snapshots

export interface PairSnapshot {
  raw: string;
  corrected: string;
}

export interface EndpointSnapshot {
  key: string;
  method: string;
  path: string;
  scenario: string;
  latency: PairSnapshot;
  ttfb: string;
  requests: number;
  ok: number;
  failed: number;
  timeouts: number;
  bytesIn: number;
  bytesOut: number;
  status: [number, number][];
  errors: [string, number][];
}

export interface ScenarioSnapshot {
  name: string;
  latency: PairSnapshot;
  iterations: number;
  ok: number;
  failed: number;
  requests: number;
  timeouts: number;
}

export interface PhaseSnapshot {
  dns: string;
  tcp: string;
  tls: string;
  connect: string;
  wait: string;
  server: string;
  transfer: string;
  connections: number;
  connectErrors: number;
}

export interface WindowSnapshot {
  /** ms from the shared t0. */
  startMs: number;
  ok: number;
  failed: number;
  bytes: number;
  /** Encoded window histogram, or null when the window was compacted (older than its horizon). */
  hist: string | null;
  summary: LatencySummary | null;
}

/** Everything PerfMetrics holds, JSON/structured-clone safe. Times are relative to the shard's t0. */
export interface MetricsSnapshot {
  global: PairSnapshot;
  warmup: PairSnapshot;
  endpoints: EndpointSnapshot[];
  scenarios: ScenarioSnapshot[];
  status: [number, number][];
  errors: [string, number][];
  errorSamples: ErrorSample[];
  errorSeen: number;
  firstErrors: [string, ErrorSample][];
  requests: number;
  ok: number;
  failed: number;
  timeouts: number;
  bytesIn: number;
  bytesOut: number;
  warmupRequests: number;
  interrupted: number;
  dropped: number;
  budgetRefused: number;
  phases: PhaseSnapshot | null;
  /** ms from t0 of the last completed measured request (0 = none). */
  lastEndRel: number;
  windowMs: number;
  windows: WindowSnapshot[];
}

function pairSnap(p: LatencyPair): PairSnapshot {
  return { raw: p.raw.encode(), corrected: p.corrected.encode() };
}

/** Serialises a generator's metrics (call after `series.closeAll()` for the final snapshot). */
export function snapshotMetrics(m: PerfMetrics, opts: { windows?: boolean } = {}): MetricsSnapshot {
  const ph = m.phases;
  return {
    global: pairSnap(m.global),
    warmup: pairSnap(m.warmup),
    endpoints: [...m.endpoints.values()].map((e) => ({
      key: e.key,
      method: e.method,
      path: e.path,
      scenario: e.scenario,
      latency: pairSnap(e.latency),
      ttfb: e.ttfb.encode(),
      requests: e.requests,
      ok: e.ok,
      failed: e.failed,
      timeouts: e.timeouts,
      bytesIn: e.bytesIn,
      bytesOut: e.bytesOut,
      status: [...e.status.entries()],
      errors: [...e.errors.entries()],
    })),
    scenarios: [...m.scenarios.values()].map((s) => ({
      name: s.name,
      latency: pairSnap(s.latency),
      iterations: s.iterations,
      ok: s.ok,
      failed: s.failed,
      requests: s.requests,
      timeouts: s.timeouts,
    })),
    status: [...m.status.entries()],
    errors: [...m.errors.entries()],
    errorSamples: m.errorReservoir.items,
    errorSeen: m.errorReservoir.seen,
    firstErrors: [...m.firstErrors.entries()],
    requests: m.requests,
    ok: m.ok,
    failed: m.failed,
    timeouts: m.timeouts,
    bytesIn: m.bytesIn,
    bytesOut: m.bytesOut,
    warmupRequests: m.warmupRequests,
    interrupted: m.interrupted,
    dropped: m.dropped,
    budgetRefused: m.budgetRefused,
    phases: ph
      ? {
          dns: ph.dns.encode(),
          tcp: ph.tcp.encode(),
          tls: ph.tls.encode(),
          connect: ph.connect.encode(),
          wait: ph.wait.encode(),
          server: ph.server.encode(),
          transfer: ph.transfer.encode(),
          connections: ph.connections,
          connectErrors: ph.connectErrors,
        }
      : null,
    lastEndRel: m.lastEndMs > 0 ? m.lastEndMs - m.startMs : 0,
    windowMs: m.series.windowMs,
    windows:
      opts.windows === false
        ? []
        : m.series.closed().map((w) => ({
            startMs: w.startMs,
            ok: w.ok,
            failed: w.failed,
            bytes: w.bytes,
            hist: w.histogram ? w.histogram.encode() : null,
            summary: w.summary,
          })),
  };
}

function addInto(h: LatencyHistogram, encoded: string): void {
  h.add(LatencyHistogram.decode(encoded));
}

function addPair(p: LatencyPair, s: PairSnapshot): void {
  addInto(p.raw, s.raw);
  addInto(p.corrected, s.corrected);
}

function addMap<K>(m: Map<K, number>, entries: readonly [K, number][]): void {
  for (const [k, v] of entries) m.set(k, (m.get(k) ?? 0) + v);
}

export interface MergedMetrics {
  /** Times relative to the shared t0 (startMs = 0). */
  metrics: PerfMetrics;
  windows: WindowLite[];
  windowMs: number;
}

/**
 * Exact merge: every histogram is a bucket-wise HDR add, every counter a sum. Error samples are
 * re-sampled to k = 50 with probability proportional to each worker's stream size (so the merged
 * reservoir stays ≈ uniform). Series windows are aligned on the shared t0; a window whose histogram
 * was already compacted in some worker (older than its 120-window horizon) gets an approximate
 * summary (max of the worker percentiles, count-weighted mean).
 */
export function mergeSnapshots(
  snaps: readonly MetricsSnapshot[],
  opts: { warmupMs: number; random: () => number },
): MergedMetrics {
  const m = new PerfMetrics({ startMs: 0, warmupEndMs: opts.warmupMs, random: opts.random });
  if (snaps.some((s) => s.phases !== null)) m.phases = new PhaseStats();
  const samples: { items: ErrorSample[]; seen: number }[] = [];
  for (const s of snaps) {
    addPair(m.global, s.global);
    addPair(m.warmup, s.warmup);
    for (const e of s.endpoints) {
      const ep = m.endpoint(e.key, e.method, e.path, e.scenario);
      addPair(ep.latency, e.latency);
      addInto(ep.ttfb, e.ttfb);
      ep.requests += e.requests;
      ep.ok += e.ok;
      ep.failed += e.failed;
      ep.timeouts += e.timeouts;
      ep.bytesIn += e.bytesIn;
      ep.bytesOut += e.bytesOut;
      addMap(ep.status, e.status);
      addMap(ep.errors, e.errors);
    }
    for (const sc of s.scenarios) {
      const st = m.scenario(sc.name);
      addPair(st.latency, sc.latency);
      st.iterations += sc.iterations;
      st.ok += sc.ok;
      st.failed += sc.failed;
      st.requests += sc.requests;
      st.timeouts += sc.timeouts;
    }
    addMap(m.status, s.status);
    addMap(m.errors, s.errors);
    for (const [k, v] of s.firstErrors) {
      const cur = m.firstErrors.get(k);
      if (cur === undefined ? m.firstErrors.size < 50 : v.tMs < cur.tMs) m.firstErrors.set(k, v);
    }
    samples.push({ items: s.errorSamples.slice(), seen: s.errorSeen });
    m.requests += s.requests;
    m.ok += s.ok;
    m.failed += s.failed;
    m.timeouts += s.timeouts;
    m.bytesIn += s.bytesIn;
    m.bytesOut += s.bytesOut;
    m.warmupRequests += s.warmupRequests;
    m.interrupted += s.interrupted;
    m.dropped += s.dropped;
    m.budgetRefused += s.budgetRefused;
    if (s.lastEndRel > m.lastEndMs) m.lastEndMs = s.lastEndRel;
    if (m.phases && s.phases) {
      const p = m.phases;
      addInto(p.dns, s.phases.dns);
      addInto(p.tcp, s.phases.tcp);
      addInto(p.tls, s.phases.tls);
      addInto(p.connect, s.phases.connect);
      addInto(p.wait, s.phases.wait);
      addInto(p.server, s.phases.server);
      addInto(p.transfer, s.phases.transfer);
      p.connections += s.phases.connections;
      p.connectErrors += s.phases.connectErrors;
    }
  }
  // Weighted reservoir merge: each kept sample of worker i stands for seen_i / kept_i stream items,
  // so samples are drawn (without replacement) with probability ∝ that weight.
  const k = m.errorReservoir.k;
  const pool = samples
    .filter((x) => x.items.length > 0)
    .map((x) => ({ items: x.items, unit: Math.max(1, x.seen) / x.items.length }));
  for (let picked = 0; picked < k; picked++) {
    let total = 0;
    for (const p of pool) total += p.items.length * p.unit;
    if (total <= 0) break;
    let r = opts.random() * total;
    let chosen: (typeof pool)[number] | undefined;
    for (const p of pool) {
      if (p.items.length === 0) continue;
      chosen = p;
      r -= p.items.length * p.unit;
      if (r < 0) break;
    }
    if (!chosen) break;
    const j = Math.floor(opts.random() * chosen.items.length);
    const [item] = chosen.items.splice(j, 1);
    if (item) m.errorReservoir.offer(item);
  }

  const windowMs = snaps[0]?.windowMs ?? 1000;
  return { metrics: m, windows: mergeWindows(snaps), windowMs };
}

function mergeWindows(snaps: readonly MetricsSnapshot[]): WindowLite[] {
  interface Acc {
    startMs: number;
    ok: number;
    failed: number;
    bytes: number;
    hist: LatencyHistogram | null;
    exact: boolean;
    summaries: LatencySummary[];
  }
  const byStart = new Map<number, Acc>();
  for (const s of snaps) {
    for (const w of s.windows) {
      let a = byStart.get(w.startMs);
      if (!a) {
        a = { startMs: w.startMs, ok: 0, failed: 0, bytes: 0, hist: null, exact: true, summaries: [] };
        byStart.set(w.startMs, a);
      }
      a.ok += w.ok;
      a.failed += w.failed;
      a.bytes += w.bytes;
      if (w.summary && w.summary.count > 0) a.summaries.push(w.summary);
      if (w.hist !== null) {
        const h = LatencyHistogram.decode(w.hist);
        if (a.hist) a.hist.add(h);
        else a.hist = h;
      } else if (w.summary && w.summary.count > 0) a.exact = false;
    }
  }
  return [...byStart.values()]
    .sort((a, b) => a.startMs - b.startMs)
    .map((a) => ({
      startMs: a.startMs,
      ok: a.ok,
      failed: a.failed,
      bytes: a.bytes,
      summary: a.exact && a.hist ? a.hist.summary() : approxSummary(a.summaries),
    }));
}

function approxSummary(list: readonly LatencySummary[]): LatencySummary | null {
  if (list.length === 0) return null;
  const count = list.reduce((x, s) => x + s.count, 0);
  const max = (f: (s: LatencySummary) => number): number => Math.max(...list.map(f));
  return {
    count,
    min: Math.min(...list.map((s) => s.min)),
    mean: count === 0 ? 0 : list.reduce((x, s) => x + s.mean * s.count, 0) / count,
    stdDev: max((s) => s.stdDev),
    p50: max((s) => s.p50),
    p75: max((s) => s.p75),
    p90: max((s) => s.p90),
    p95: max((s) => s.p95),
    p99: max((s) => s.p99),
    p999: max((s) => s.p999),
    max: max((s) => s.max),
  };
}
