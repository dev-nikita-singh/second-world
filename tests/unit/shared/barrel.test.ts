import { describe, expect, it } from "vitest";
import * as sharedNs from "../../../src/shared/index.js";

const shared: Record<string, unknown> = { ...sharedNs };

describe("shared barrel", () => {
  it("exports the contract surface", () => {
    for (const name of [
      "Semaphore",
      "RingBuffer",
      "MinHeap",
      "KeyedMinHeap",
      "TopK",
      "LRUCache",
      "Bitset",
      "UnionFind",
      "KeyedUnionFind",
      "LatencyHistogram",
      "Welford",
      "WindowedSeries",
      "Ewma",
      "Reservoir",
      "quantile",
      "median",
      "bootstrapCI",
      "mannWhitneyU",
      "cliffsDelta",
      "hodgesLehmann",
      "holm",
      "madZ",
      "wilson",
      "compareSamples",
      "cusum",
      "theilSen",
      "kneedle",
      "DiGraph",
      "bfs",
      "dfs",
      "reachable",
      "tarjanScc",
      "topoSort",
      "topoLevels",
      "CycleError",
      "findCycles",
      "shortestCycle",
      "impactOf",
      "longestPath",
      "ulid",
      "sha256",
      "fnv1a",
      "backoff",
      "fingerprint",
    ]) {
      expect(shared[name], name).toBeDefined();
    }
  });
});
