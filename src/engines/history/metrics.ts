/**
 * Flatten engine results into comparable summary metrics, and metric direction.
 * See docs/03-engines/evidence-and-history.md §B.2 (regression detection, trends).
 */
import type { EngineResult, Severity } from "../../core/evidence/schemas.js";
import type { PerformanceData } from "../performance/types.js";
import type { StressData } from "../stress/types.js";

const LAT_STATS = ["mean", "p50", "p90", "p95", "p99", "max"] as const;

export function extractMetrics(results: readonly EngineResult[]): Record<string, number> {
  const m: Record<string, number> = {};
  const put = (k: string, v: unknown): void => {
    if (typeof v === "number" && Number.isFinite(v)) m[k] = v;
  };
  for (const r of results) {
    if (r.engine === "performance" && r.data) {
      const d = r.data as Partial<PerformanceData>;
      const lat = d.latency?.corrected;
      if (lat) for (const s of LAT_STATS) put(`performance.http.${s}`, lat[s]);
      put("performance.http.rps", d.totals?.rps);
      put("performance.http.error_rate", d.totals?.errorRate);
      put("performance.http.requests", d.totals?.requests);
      for (const e of d.endpoints ?? []) {
        for (const s of ["p50", "p95", "p99"] as const)
          put(`performance.endpoint.${e.key}.${s}`, e.latency.corrected[s]);
        put(`performance.endpoint.${e.key}.error_rate`, e.errorRate);
        put(`performance.endpoint.${e.key}.rps`, e.rps);
      }
    } else if (r.engine === "stress" && r.data) {
      const d = r.data as Partial<StressData>;
      put("stress.tested_capacity", d.capacity?.testedCapacity);
      put("stress.first_breach_level", d.firstBreach?.level);
      put("stress.knee_level", d.knee?.level);
      put("stress.spike_recovery_s", d.spike?.recoveryTimeS);
      put("stress.soak_p95_slope_ms_per_h", d.soak?.p95SlopeMsPerHour);
    }
    put(`${r.engine}.findings`, r.findings.length);
  }
  return m;
}

const HIGHER_BETTER = /(\.rps|\.throughput|tested_capacity|first_breach_level|knee_level|success_rate|\.ok)$/;

export function metricDirection(metric: string): "lower-is-better" | "higher-is-better" {
  return HIGHER_BETTER.test(metric) ? "higher-is-better" : "lower-is-better";
}

const SEV_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export function maxSeverity(sevs: readonly Severity[]): Severity | null {
  for (const s of SEV_ORDER) if (sevs.includes(s)) return s;
  return null;
}

/** Overall status of a combined run: cancelled > error > failed > partial > passed > skipped. */
export function overallStatus(results: readonly EngineResult[]): EngineResult["status"] {
  const order: EngineResult["status"][] = ["cancelled", "error", "failed", "partial", "passed", "skipped"];
  for (const s of order) if (results.some((r) => r.status === s)) return s;
  return "skipped";
}
