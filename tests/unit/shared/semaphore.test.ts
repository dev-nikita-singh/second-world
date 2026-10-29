import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Semaphore } from "../../../src/shared/ds/semaphore.js";

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("Semaphore", () => {
  it("rejects invalid max", () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
  });

  it("tryAcquire and idempotent release", () => {
    const s = new Semaphore(2);
    const a = s.tryAcquire();
    const b = s.tryAcquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(s.tryAcquire()).toBeNull();
    expect(s.available).toBe(0);
    a?.();
    a?.();
    expect(s.available).toBe(1);
    b?.();
    expect(s.available).toBe(2);
  });

  it("hands permits to waiters in FIFO order", async () => {
    const s = new Semaphore(1);
    const first = await s.acquire();
    const order: number[] = [];
    const ps = [1, 2, 3, 4].map((i) =>
      s.acquire().then((rel) => {
        order.push(i);
        return rel;
      }),
    );
    expect(s.waiting).toBe(4);
    // a newcomer must not barge ahead of queued waiters
    expect(s.tryAcquire()).toBeNull();
    first();
    for (const p of ps) (await p)();
    expect(order).toEqual([1, 2, 3, 4]);
    expect(s.available).toBe(1);
  });

  it("abort removes the waiter and rejects with signal.reason", async () => {
    const s = new Semaphore(1);
    const rel = await s.acquire();
    const ac = new AbortController();
    const p = s.acquire(ac.signal);
    const q = s.acquire();
    expect(s.waiting).toBe(2);
    const reason = new Error("stop");
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(s.waiting).toBe(1);
    rel();
    const r2 = await q;
    r2();
    expect(s.available).toBe(1);
  });

  it("already-aborted signal rejects immediately", async () => {
    const s = new Semaphore(1);
    const ac = new AbortController();
    ac.abort("x");
    await expect(s.acquire(ac.signal)).rejects.toBe("x");
    expect(s.available).toBe(1);
  });

  it("abort after grant does not leak a permit", async () => {
    const s = new Semaphore(1);
    const ac = new AbortController();
    const rel = await s.acquire(ac.signal);
    ac.abort();
    rel();
    expect(s.available).toBe(1);
  });

  it("property: never exceeds max concurrency, all tasks complete, permits restored", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.record({ work: fc.integer({ min: 0, max: 3 }), abort: fc.boolean() }), { maxLength: 40 }),
        async (max, tasks) => {
          const s = new Semaphore(max);
          let inFlight = 0;
          let peak = 0;
          const started: number[] = [];
          const runs = tasks.map(async (t, i) => {
            const ac = new AbortController();
            if (t.abort) queueMicrotask(() => ac.abort(new Error("a")));
            let rel: () => void;
            try {
              rel = await s.acquire(t.abort ? ac.signal : undefined);
            } catch {
              return;
            }
            started.push(i);
            inFlight++;
            peak = Math.max(peak, inFlight);
            for (let k = 0; k < t.work; k++) await tick();
            inFlight--;
            rel();
          });
          await Promise.all(runs);
          expect(peak).toBeLessThanOrEqual(max);
          expect(s.available).toBe(max);
          expect(s.waiting).toBe(0);
          // non-aborted tasks start in FIFO order
          const nonAborted = started.filter((i) => !tasks[i]?.abort);
          expect(nonAborted).toEqual([...nonAborted].sort((a, b) => a - b));
        },
      ),
      { numRuns: 100 },
    );
  });
});
