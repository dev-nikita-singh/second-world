import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../src/core/clock.js";
import { Gcra } from "../../../src/core/safety/gcra.js";

// Regression: the perf engine counted "throttled" waits from wall-clock deltas, which misfired
// under event-loop lag. `take()` now reports whether the GCRA itself imposed a delay.
describe("Gcra.take reports whether it waited", () => {
  it("resolves false when the cell conforms immediately", async () => {
    const clock = createFakeClock(0);
    const g = new Gcra({ rate: 10, burst: 1 });
    await expect(g.take(clock)).resolves.toBe(false);
  });

  it("resolves false while spacing is respected, regardless of lag", async () => {
    const clock = createFakeClock(0);
    const g = new Gcra({ rate: 10, burst: 1 });
    expect(await g.take(clock)).toBe(false);
    clock.advance(150); // more than 1/rate later: conforms without waiting
    expect(await g.take(clock)).toBe(false);
  });

  it("resolves true when the cap forced a wait", async () => {
    const clock = createFakeClock(0);
    const g = new Gcra({ rate: 10, burst: 1 });
    expect(await g.take(clock)).toBe(false);
    const p = g.take(clock); // immediately again: must wait ~100 ms
    clock.advance(100);
    await expect(p).resolves.toBe(true);
  });
});
