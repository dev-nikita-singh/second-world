/**
 * Built-in scenario catalogue. See docs/03-engines/reliability-lab.md §4.
 * A scenario turns parameters into a fault for a given injector kind, or reports that it needs an
 * adapter that is not configured (→ limitation, no injection).
 */

import type { FaultInput } from "../../adapters/faults/types.js";
import { parseDuration } from "../../core/config/units.js";

export type InjectorKind = "builtin" | "toxiproxy" | "docker";
export type DetectorId = "amplification" | "jitter" | "breaker" | "timeout" | "recovery" | "isolation";

export interface ScenarioDef {
  id: string;
  title: string;
  description: string;
  /** Injectors that can run it, in preference order. */
  injectors: InjectorKind[];
  params: Record<string, string>;
  /** Detectors that are meaningful for this fault. */
  detectors: DetectorId[];
}

export interface BuildContext {
  injector: InjectorKind;
  container?: string | undefined;
  network?: string | undefined;
}

export type BuildResult = { ok: true; fault: FaultInput; note?: string } | { ok: false; limitation: string };

type P = Record<string, string | number | boolean>;

function ms(p: P, key: string, def: number): number {
  const v = p[key];
  if (v === undefined || typeof v === "boolean") return def;
  return parseDuration(v);
}

function num(p: P, key: string, def: number): number {
  const v = p[key];
  if (v === undefined || typeof v === "boolean") return def;
  const s = String(v).trim();
  const n = s.endsWith("%") ? Number(s.slice(0, -1)) : Number(s);
  if (!Number.isFinite(n)) throw new Error(`parameter ${key}: not a number (${String(v)})`);
  return n;
}

const ALL: readonly (ScenarioDef & { build(p: P, c: BuildContext): BuildResult })[] = [
  {
    id: "dependency-latency",
    title: "Dependency latency",
    description: "Adds fixed latency (± jitter) to every call to the dependency.",
    injectors: ["builtin", "toxiproxy"],
    params: {
      latency: "added latency (default 2s)",
      jitter: "± jitter (default 0)",
      percent: "share of calls (default 100)",
    },
    detectors: ["recovery", "isolation", "amplification"],
    build: (p) => ({
      ok: true,
      fault: {
        type: "latency",
        latencyMs: ms(p, "latency", 2000),
        jitterMs: ms(p, "jitter", 0),
        percent: num(p, "percent", 100),
      },
    }),
  },
  {
    id: "dependency-timeout",
    title: "Dependency black-hole (timeout)",
    description: "The dependency accepts connections but never answers: checks outbound timeouts.",
    injectors: ["builtin", "toxiproxy", "docker"],
    params: {},
    detectors: ["timeout", "breaker", "amplification", "recovery", "isolation"],
    build: (_p, c) =>
      c.injector === "docker"
        ? c.container
          ? {
              ok: true,
              fault: { type: "container", action: "pause", container: c.container },
              note: "emulated with docker pause",
            }
          : { ok: false, limitation: "docker injector needs dependencies.<name>.container" }
        : { ok: true, fault: { type: "blackhole" } },
  },
  {
    id: "dependency-5xx",
    title: "Dependency returns 5xx",
    description:
      "Every call returns an HTTP error (default 503): retries, circuit breaker, error propagation.",
    injectors: ["builtin"],
    params: { status: "HTTP status (default 503)", percent: "share of calls (default 100)" },
    detectors: ["amplification", "jitter", "breaker", "recovery", "isolation"],
    build: (p) => ({
      ok: true,
      fault: { type: "http-status", status: num(p, "status", 503), percent: num(p, "percent", 100) },
    }),
  },
  {
    id: "dependency-reset",
    title: "Dependency resets connections",
    description: "Connections are reset (RST) by the dependency.",
    injectors: ["builtin", "toxiproxy"],
    params: { percent: "share of calls (default 100)" },
    detectors: ["amplification", "jitter", "breaker", "recovery", "isolation"],
    build: (p) => ({ ok: true, fault: { type: "reset", percent: num(p, "percent", 100) } }),
  },
  {
    id: "restart-dependency",
    title: "Dependency restart",
    description:
      "The dependency goes down and comes back (docker restart; built-in proxy emulates the downtime with resets).",
    injectors: ["docker", "builtin", "toxiproxy"],
    params: { downtime: "builtin/toxiproxy: emulated downtime (default = fault duration)" },
    detectors: ["amplification", "recovery", "isolation"],
    build: (_p, c) =>
      c.injector === "docker"
        ? c.container
          ? {
              ok: true,
              fault: { type: "container", action: "stop", container: c.container },
              note: "stop for the fault duration, start on revert",
            }
          : { ok: false, limitation: "docker injector needs dependencies.<name>.container" }
        : {
            ok: true,
            fault: { type: "reset" },
            note: "restart emulated as connection resets for the fault duration",
          },
  },
  {
    id: "flapping-dependency",
    title: "Flapping dependency",
    description: "The dependency alternates between failing and healthy (on/off cycles).",
    injectors: ["builtin"],
    params: {
      onMs: "failing period (default 1s)",
      offMs: "healthy period (default 1s)",
      status: "HTTP status (default 503)",
    },
    detectors: ["amplification", "recovery", "isolation"],
    build: (p) => ({
      ok: true,
      fault: {
        type: "http-status",
        status: num(p, "status", 503),
        flapping: { onMs: ms(p, "onMs", 1000), offMs: ms(p, "offMs", 1000) },
      },
    }),
  },
  {
    id: "partial-failure",
    title: "Partial failure",
    description: "A share of calls fail (default 30 % → 503).",
    injectors: ["builtin"],
    params: { percent: "share of failing calls (default 30)", status: "HTTP status (default 503)" },
    detectors: ["amplification", "jitter", "recovery", "isolation"],
    build: (p) => ({
      ok: true,
      fault: { type: "http-status", status: num(p, "status", 503), percent: num(p, "percent", 30) },
    }),
  },
  {
    id: "slow-network",
    title: "Slow network",
    description: "Latency with jitter plus a bandwidth cap on the dependency link.",
    injectors: ["builtin", "toxiproxy"],
    params: { latency: "default 100ms", jitter: "default 50ms", bandwidth: "bytes/s (default 50000)" },
    detectors: ["recovery", "isolation"],
    build: (p) => ({
      ok: true,
      fault: { type: "latency", latencyMs: ms(p, "latency", 100), jitterMs: ms(p, "jitter", 50) },
      note: `bandwidth ${num(p, "bandwidth", 50_000)} B/s applied as a second fault`,
    }),
  },
  {
    id: "db-unavailable",
    title: "Database unavailable",
    description:
      "Stops the database container (requires the docker injector and dependencies.<db>.container).",
    injectors: ["docker"],
    params: {},
    detectors: ["recovery", "isolation"],
    build: (_p, c) =>
      c.injector === "docker" && c.container
        ? { ok: true, fault: { type: "container", action: "stop", container: c.container } }
        : {
            ok: false,
            limitation:
              "db-unavailable requires the docker adapter (dependencies.<db>.injector=docker + container)",
          },
  },
  {
    id: "cache-unavailable",
    title: "Cache unavailable",
    description:
      "Pauses the cache container (requires the docker injector) or resets cache connections (builtin tcp proxy).",
    injectors: ["docker", "builtin"],
    params: {},
    detectors: ["recovery", "isolation"],
    build: (_p, c) =>
      c.injector === "docker"
        ? c.container
          ? { ok: true, fault: { type: "container", action: "pause", container: c.container } }
          : { ok: false, limitation: "cache-unavailable via docker needs dependencies.<cache>.container" }
        : {
            ok: true,
            fault: { type: "reset" },
            note: "cache connections reset via the built-in proxy (use mode: tcp)",
          },
  },
];

/** Scenario catalogue (for `sw reliability list`). */
export function listScenarios(): ScenarioDef[] {
  return ALL.map(({ build: _b, ...d }) => ({
    ...d,
    injectors: [...d.injectors],
    params: { ...d.params },
    detectors: [...d.detectors],
  }));
}

export function getScenario(
  id: string,
): (ScenarioDef & { build(p: P, c: BuildContext): BuildResult }) | undefined {
  return ALL.find((s) => s.id === id);
}

/** Extra faults some scenarios stack (slow-network adds bandwidth). */
export function extraFaults(id: string, p: P): FaultInput[] {
  if (id === "slow-network") return [{ type: "bandwidth", bytesPerSecond: num(p, "bandwidth", 50_000) }];
  return [];
}
