import { afterEach, describe, expect, it } from "vitest";
import { startCalibratedServer } from "../../fixtures/servers/calibrated.js";
import { type ChildCalibratedServer, startCalibratedServerInChild } from "../../fixtures/servers/calibrated-child.js";

let child: ChildCalibratedServer | undefined;
afterEach(async () => {
  await child?.close();
  child = undefined;
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Parent event-loop utilization (0..1) while keeping `conc` loops of GET url busy for `ms`. */
async function parentEluUnderLoad(url: string, ms: number, conc: number): Promise<number> {
  const e0 = performance.eventLoopUtilization();
  const end = performance.now() + ms;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (performance.now() < end) await (await fetch(url)).arrayBuffer();
    }),
  );
  return performance.eventLoopUtilization(e0).utilization;
}

describe("startCalibratedServerInChild", () => {
  it("serves the same routes and exposes stats/behaviour over RPC", async () => {
    child = await startCalibratedServerInChild({ seed: 7 });
    expect(child.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(child.pid).not.toBe(process.pid);

    const t0 = performance.now();
    expect((await fetch(`${child.url}/fixed/30`)).status).toBe(200);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(29);

    let fails = 0;
    for (let i = 0; i < 20; i++) if ((await fetch(`${child.url}/error/25`)).status === 500) fails++;
    expect(fails).toBe(5);

    const st = await child.stats();
    expect(st.requests).toBe(21);
    expect(st.byRoute["/error"]).toBe(20);
    expect(st.byStatus["500"]).toBe(5);

    await child.resetStats();
    expect((await child.stats()).requests).toBe(0);

    await child.stallFor(300);
    const s0 = performance.now();
    await fetch(`${child.url}/stall`);
    expect(performance.now() - s0).toBeGreaterThanOrEqual(250);

    await child.setBehavior({ stallUntilMs: Date.now() + 10_000 });
    const held = fetch(`${child.url}/stall`);
    await new Promise((r) => setTimeout(r, 50));
    expect((await child.stats()).inFlight).toBe(1);
    await child.setBehavior({ stallUntilMs: 0 });
    expect((await held).status).toBe(200);
  });

  it("close() stops the child process (idempotent) and later RPCs reject", async () => {
    child = await startCalibratedServerInChild();
    const { pid, url } = child;
    const pending = fetch(`${url}/capacity/1?ms=10000`).catch(() => "reset");
    await new Promise((r) => setTimeout(r, 50));
    const t0 = performance.now();
    await child.close();
    await child.close();
    expect(performance.now() - t0).toBeLessThan(3500);
    expect(alive(pid)).toBe(false);
    await pending;
    await expect(child.stats()).rejects.toThrow(/not running/);
    child = undefined;
  });

  it("keeps the precise-timer spin off the parent's event loop (the false 'generator-saturated' cause)", async () => {
    const inproc = await startCalibratedServer();
    let eluIn: number;
    try {
      eluIn = await parentEluUnderLoad(`${inproc.url}/fixed/30`, 1000, 2);
    } finally {
      await inproc.close();
    }
    child = await startCalibratedServerInChild();
    const eluChild = await parentEluUnderLoad(`${child.url}/fixed/30`, 1000, 2);
    // In-process the spin keeps the parent's event loop busy for ~2/3 of every 30 ms
    // request; out of process the parent loop is mostly idle.
    // (Absolute values shrink when the machine is busy: late timers shorten the spin window,
    // so only a sanity floor plus the relative comparison is asserted.)
    expect(eluIn).toBeGreaterThan(0.15);
    expect(eluChild).toBeLessThan(eluIn * 0.6);
  });
});
