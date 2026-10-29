import { describe, expect, it } from "vitest";
import {
  evaluateGeneratorHealth,
  LAG_RULE_MIN_SAMPLES,
} from "../../../src/engines/performance/self-check.js";

// Regression (reported by sw-stress): with ~50 arrivals p99 ≈ max, so one cold-start outlier of a few ms
// flagged the generator as saturated. The lag rule now needs LAG_RULE_MIN_SAMPLES arrivals.
const base = {
  model: "open" as const,
  eldP99Ms: 5,
  eldMaxMs: 10,
  cpuMs: 100,
  spinMs: 0,
  wallMs: 1000,
  lagP99Ms: 3.4,
  lagMaxMs: 3.4,
  intervalMs: 20,
  targetRate: 50,
  achievedRate: 50,
  dropped: 0,
  meanInFlight: 1,
  completed: 50,
  measuredMs: 1000,
  throughput: 50,
  meanLatencyMs: 20,
  latencyFlat: true,
  maxOpenSockets: 1,
  connections: 64,
};

describe("scheduling-lag rule minimum evidence", () => {
  it("ignores a single outlier when there are too few arrivals", () => {
    const r = evaluateGeneratorHealth({ ...base, lagSamples: 50 });
    expect(r.health.saturated).toBe(false);
  });

  it("still fires with enough arrivals", () => {
    const r = evaluateGeneratorHealth({ ...base, lagSamples: LAG_RULE_MIN_SAMPLES });
    expect(r.health.saturated).toBe(true);
    expect(r.health.reasons.join(" ")).toMatch(/scheduling lag/);
  });
});
