import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../src/core/clock.js";
import { createEventBus } from "../../../src/core/events.js";
import { createEvidenceStore, createFinding } from "../../../src/core/evidence/store.js";
import { createMemoryLogger } from "../../../src/core/log/logger.js";

describe("event bus", () => {
  it("on/once/off and wildcard", () => {
    const bus = createEventBus<{ "perf.tick": { rps: number } }>();
    const got: unknown[] = [];
    const off = bus.on("perf.tick", (p) => got.push(p.rps));
    bus.once("perf.tick", () => got.push("once"));
    bus.on("*", (_p, e) => got.push(`*${e}`));
    bus.emit("perf.tick", { rps: 1 });
    bus.emit("perf.tick", { rps: 2 });
    off();
    bus.emit("perf.tick", { rps: 3 });
    expect(got).toEqual([1, "once", "*perf.tick", 2, "*perf.tick", "*perf.tick"]);
    expect(bus.listenerCount("perf.tick")).toBe(0);
  });
  it("isolates listener errors (sync and async) and logs them", async () => {
    const log = createMemoryLogger();
    const bus = createEventBus({ log });
    let reached = false;
    bus.on("x", () => {
      throw new Error("bad listener");
    });
    bus.on("x", async () => {
      throw new Error("bad async");
    });
    bus.on("x", () => {
      reached = true;
    });
    expect(() => bus.emit("x", null)).not.toThrow();
    expect(reached).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(log.records.map((r) => r.error)).toEqual(["bad listener", "bad async"]);
  });
  it("unsubscribing during emit is safe", () => {
    const bus = createEventBus();
    const calls: number[] = [];
    const offA = bus.on("e", () => {
      calls.push(1);
      offB();
    });
    const offB = bus.on("e", () => calls.push(2));
    bus.emit("e", 0);
    bus.emit("e", 0);
    offA();
    expect(calls).toEqual([1, 2, 1]);
  });
});

describe("evidence store", () => {
  const clock = createFakeClock(0);
  const base = {
    engine: "performance" as const,
    category: "performance" as const,
    title: "p95 latency 412ms exceeds 300ms",
    severity: "high" as const,
    classification: "threshold-breach" as const,
    confidence: 0.9,
    evidence: [{ kind: "threshold" as const, expression: "p95 < 300ms", actual: 412, passed: false }],
    affected: ["GET /api/products"],
  };

  it("createFinding fills id, fingerprint, timestamps and defaults", () => {
    const f = createFinding(base, { clock, newId: () => "ID1" });
    expect(f.id).toBe("ID1");
    expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(f.firstSeen).toBe("2026-01-01T00:00:00.000Z");
    expect(f.lastSeen).toBe(f.firstSeen);
    expect(f.occurrences).toBe(1);
    expect(f.status).toBe("open");
    // numbers in title don't change the fingerprint
    expect(createFinding({ ...base, title: "p95 latency 500ms exceeds 300ms" }).fingerprint).toBe(f.fingerprint);
    expect(() => createFinding({ ...base, evidence: [] })).toThrow();
  });

  it("dedups by fingerprint", () => {
    const store = createEvidenceStore();
    const a = store.addFinding(createFinding(base, { clock }));
    clock.advance(5000);
    const b = store.addFinding(
      createFinding(
        { ...base, evidence: [{ kind: "note", text: "again" }] },
        { clock },
      ),
    );
    expect(b).toBe(a);
    expect(a.occurrences).toBe(2);
    expect(a.lastSeen).toBe("2026-01-01T00:00:05.000Z");
    expect(a.evidence).toHaveLength(2);
    expect(store.size).toBe(1);
    expect(store.get(a.id)).toBe(a);
    store.addFinding(createFinding({ ...base, engine: "bugs", category: "bug" }, { clock }));
    expect(store.findings({ engine: "bugs" })).toHaveLength(1);
    expect(store.findings()).toHaveLength(2);
  });

  it("limitations are deduped; results recorded", () => {
    const store = createEvidenceStore();
    store.addLimitation("performance", { code: "NO_TELEMETRY", message: "m", impact: "informational" });
    store.addLimitation("performance", { code: "NO_TELEMETRY", message: "m", impact: "informational" });
    expect(store.limitations()).toHaveLength(1);
    store.addResult({
      engine: "performance",
      runId: "r",
      status: "passed",
      startedAt: "a",
      endedAt: "b",
      findings: [createFinding(base)],
      limitations: [],
      artifacts: [],
      schemaVersion: 1,
    });
    expect(store.results()).toHaveLength(1);
    expect(store.size).toBe(1);
  });
});
