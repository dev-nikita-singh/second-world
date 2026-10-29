/**
 * EngineContext factory. See docs/02-architecture.md §4.
 * Test-friendly defaults: silent logger, systemClock, seed 1, permissive local-only safety guard,
 * synchronous environment stub (no subprocesses), ULID ids.
 */
import { arch, availableParallelism, release, totalmem } from "node:os";
import { ulid } from "ulid";
import { systemClock } from "./clock.js";
import { createEventBus } from "./events.js";
import { createEvidenceStore } from "./evidence/store.js";
import { silentLogger } from "./log/logger.js";
import { createRng } from "./rng.js";
import { createSafetyGuard } from "./safety/guard.js";
import type { EngineContext, EnvironmentReport } from "./types.js";

/** Cheap, synchronous environment report (no I/O beyond node:os). Use probeEnvironment() for the full one. */
export function stubEnvironmentReport(): EnvironmentReport {
  let cpus = 1;
  try {
    cpus = availableParallelism();
  } catch {
    // keep 1
  }
  return {
    os: { platform: process.platform, release: release(), arch: arch() },
    runtime: {
      name: "node",
      version: process.versions.node,
      features: { workerThreads: true, sqlite: false, compileCache: false },
    },
    resources: { cpus, memTotal: totalmem() },
    container: { inside: false },
    ci: { inside: false },
    terminal: { tty: false, color: false, unicode: true, width: 80 },
    network: { extraCA: false },
    tools: {},
    capabilities: {},
  };
}

export interface CreateEngineContextOptions extends Partial<EngineContext> {
  /** Seed for the default rng (ignored when `rng` is given). Default 1. */
  seed?: number;
}

export function createEngineContext(partial: CreateEngineContextOptions = {}): EngineContext {
  const { seed, ...rest } = partial;
  const log = rest.log ?? silentLogger;
  const clock = rest.clock ?? systemClock;
  const signal = rest.signal ?? new AbortController().signal;
  return {
    signal,
    clock,
    rng: rest.rng ?? createRng(seed ?? 1),
    log,
    events: rest.events ?? createEventBus({ log }),
    evidence: rest.evidence ?? createEvidenceStore(),
    safety: rest.safety ?? createSafetyGuard({}, { interactive: false, signal, clock }),
    env: rest.env ?? stubEnvironmentReport(),
    config: rest.config ?? {},
    newId: rest.newId ?? (() => ulid()),
  };
}
