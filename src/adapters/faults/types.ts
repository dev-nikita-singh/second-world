/**
 * Fault model + injector contract. See docs/03-engines/reliability-lab.md §1 and
 * docs/11-safety-security-privacy.md §1 ("Leftover faults": cleanup stack, TTL, watchdog).
 *
 * Every fault may be partial (`percent` < 100: deterministic counter selection, exactly
 * `percent` of every 100 requests/connections) and/or flapping (`flapping: { onMs, offMs }`).
 */
import { z } from "zod";
import { parseDuration } from "../../core/config/units.js";

const Ms = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return parseDuration(v);
  } catch (e) {
    ctx.addIssue({
      code: "custom",
      message: e instanceof Error ? e.message : `invalid duration ${String(v)}`,
    });
    return z.NEVER;
  }
});

const Common = {
  /** Stable id; generated when omitted. */
  id: z.string().min(1).optional(),
  /** Share of requests (http mode) or connections (tcp mode) affected, 0..100. Default 100. */
  percent: z.number().min(0).max(100).default(100),
  /** On/off cycles: the fault is active for `onMs`, inactive for `offMs`, repeating from apply time. */
  flapping: z.object({ onMs: Ms, offMs: Ms }).strict().optional(),
  /** Auto-revert after this long (TTL watchdog), even if the caller forgets. */
  ttlMs: Ms.optional(),
};

export const FaultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("latency"), latencyMs: Ms, jitterMs: Ms.default(0), ...Common }).strict(),
  z.object({ type: z.literal("bandwidth"), bytesPerSecond: z.number().positive(), ...Common }).strict(),
  z
    .object({
      type: z.literal("reset"),
      /**
       * before-request (default): RST instead of forwarding. after-response: forward the request, let
       * the upstream answer (its work is done), then RST the client instead of relaying the response:
       * the caller sees a reset for an operation that WAS applied (built-in proxy only).
       */
      when: z.enum(["before-request", "after-response"]).optional(),
      ...Common,
    })
    .strict(),
  z.object({ type: z.literal("blackhole"), ...Common }).strict(),
  z
    .object({
      type: z.literal("http-status"),
      status: z.number().int().min(100).max(599).default(503),
      body: z.string().optional(),
      ...Common,
    })
    .strict(),
  z
    .object({
      type: z.literal("slow-body"),
      delayMs: Ms,
      chunkBytes: z.number().int().positive().default(64),
      ...Common,
    })
    .strict(),
  z
    .object({
      type: z.literal("container"),
      action: z.enum(["pause", "stop", "restart", "network-disconnect"]),
      container: z.string().min(1),
      network: z.string().optional(),
      ...Common,
    })
    .strict(),
]);

export type Fault = z.output<typeof FaultSchema>;
export type FaultInput = z.input<typeof FaultSchema>;
export type FaultType = Fault["type"];

export const ALL_FAULT_TYPES: readonly FaultType[] = [
  "latency",
  "bandwidth",
  "reset",
  "blackhole",
  "http-status",
  "slow-body",
  "container",
];

export function parseFault(input: FaultInput | Fault): Fault {
  return FaultSchema.parse(input);
}

export interface InjectorCapabilities {
  injector: string;
  available: boolean;
  /** Why it is unavailable (when available=false). */
  reason?: string;
  faults: FaultType[];
  /** Supports percent < 100 natively. */
  partial: boolean;
  /** Supports flapping natively (otherwise the engine toggles apply/revert). */
  flapping: boolean;
  /** Can count requests seen per upstream (needed for retry amplification). */
  countsRequests: boolean;
}

export interface AppliedFault {
  id: string;
  fault: Fault;
  /** Clock ms when applied. */
  appliedAt: number;
  revert(): Promise<void>;
}

/** All injectors implement this. `revert()` (no id) reverts everything this injector applied. */
export interface FaultInjector {
  readonly name: string;
  capabilities(): Promise<InjectorCapabilities>;
  /** Applies a fault. If `signal` aborts, the fault is reverted immediately. */
  apply(fault: FaultInput | Fault, signal?: AbortSignal): Promise<AppliedFault>;
  revert(id?: string): Promise<void>;
  /** Active fault ids. */
  active(): string[];
  /** Releases resources (reverts first). */
  close(): Promise<void>;
}

/** Deterministic exact-percentage selection by counter (the n-th event, 0-based). */
export function selectByCounter(n: number, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  return Math.floor(((n + 1) * percent) / 100) > Math.floor((n * percent) / 100);
}

/** Flapping schedule: active during [k·(on+off), k·(on+off)+on). */
export function flapActive(elapsedMs: number, onMs: number, offMs: number): boolean {
  const period = onMs + offMs;
  if (period <= 0 || offMs <= 0) return true;
  if (onMs <= 0) return false;
  const phase = ((elapsedMs % period) + period) % period;
  return phase < onMs;
}

/** Describes a fault for logs/evidence. */
export function describeFault(f: Fault): string {
  let s: string;
  switch (f.type) {
    case "latency":
      s = `latency ${f.latencyMs}ms${f.jitterMs > 0 ? ` ±${f.jitterMs}ms` : ""}`;
      break;
    case "bandwidth":
      s = `bandwidth ${f.bytesPerSecond} B/s`;
      break;
    case "reset":
      s = f.when === "after-response" ? "connection reset after the upstream responded" : "connection reset";
      break;
    case "blackhole":
      s = "black-hole (no response)";
      break;
    case "http-status":
      s = `HTTP ${f.status}`;
      break;
    case "slow-body":
      s = `slow body (${f.chunkBytes} B every ${f.delayMs}ms)`;
      break;
    case "container":
      s = `container ${f.action} ${f.container}`;
      break;
  }
  if (f.percent < 100) s += ` on ${f.percent}%`;
  if (f.flapping) s += ` flapping ${f.flapping.onMs}ms on/${f.flapping.offMs}ms off`;
  return s;
}
