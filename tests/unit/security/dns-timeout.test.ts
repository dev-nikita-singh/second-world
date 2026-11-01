/**
 * The default resolver (dns.promises.lookup → getaddrinfo) has no timeout of its own; a stalled
 * resolver must not hang pre-flight or the mid-run rebinding check (docs/11 §2, threat model D2).
 */
import { describe, expect, it } from "vitest";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";

const never = (): Promise<never> => new Promise<never>(() => {});
const within = <T>(p: Promise<T>, ms: number): Promise<T | "hang"> =>
  Promise.race([p, new Promise<"hang">((r) => setTimeout(() => r("hang"), ms).unref())]);

describe("Safety Guard DNS timeout", () => {
  it("pre-flight on a name whose resolution never completes fails with SW_TARGET_DNS (no hang)", async () => {
    const g = createSafetyGuard({}, { interactive: false, resolver: never, dnsTimeoutMs: 50 });
    const r = await within(
      g.preflight("http://localhost:3000/").then(
        () => "pinned",
        (e: { code?: string }) => e.code,
      ),
      3000,
    );
    expect(r).toBe("SW_TARGET_DNS");
  });

  it("recheckDns with a stalled resolver returns (keeps the pinned addresses) instead of hanging", async () => {
    let stall = false;
    const g = createSafetyGuard(
      {},
      {
        interactive: false,
        dnsTimeoutMs: 50,
        resolver: async () => (stall ? never() : [{ address: "127.0.0.1", family: 4 }]),
      },
    );
    await g.preflight("http://localhost:3000/");
    stall = true;
    expect(
      await within(
        g.recheckDns("localhost").then(() => "done"),
        3000,
      ),
    ).toBe("done");
    expect(g.killSwitch.aborted).toBe(false);
  });
});
