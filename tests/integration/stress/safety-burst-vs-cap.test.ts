/**
 * Gap 2 (sw-gaps-w8, found by sw-real2-w8 on orders-jobs-api): STRESS-SAFETY-RATE-CAP said a stage
 * was "throttled by safety.maxRps 500 req/s" while it ran at ~98 req/s. Root cause: closed-loop VUs
 * whose responses arrive together (a batch released at once, long-polls finishing together) send
 * bursts larger than the world-wide GCRA burst tolerance (ceil(maxRps/10) = 50 cells), so a few
 * requests wait a few ms and the Performance Lab counts them as throttled — although the stage's
 * mean rate is far below the cap. Such a stage is not capped; only a stage whose measured rate
 * is near the cap is.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import { runStress } from "../../../src/engines/stress/index.js";

let server: Server;
let url = "";
let timer: NodeJS.Timeout | undefined;
let held: ServerResponse[] = [];

beforeEach(async () => {
  held = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    if (req.url?.startsWith("/batch")) {
      held.push(res); // answered together every 600 ms
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  timer = setInterval(() => {
    for (const res of held.splice(0)) res.writeHead(200).end("{}");
  }, 600);
});

afterEach(async () => {
  if (timer) clearInterval(timer);
  for (const res of held.splice(0)) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("safety cap vs GCRA burst smoothing", () => {
  it("bursty stage far below safety.maxRps is not reported as capped by it", {
    timeout: 30_000,
  }, async () => {
    const safety = createSafetyGuard(
      { maxRps: 500, maxConcurrency: 200 },
      { interactive: false, signal: new AbortController().signal },
    );
    // 48 VUs: GET /batch (released together) then GET /fast → bursts of ~96 requests every 600 ms
    // (~160 req/s mean, < 1/3 of the cap), each burst above the 50-cell GCRA tolerance.
    const r = await runStress(
      {
        target: url,
        scenarios: [
          {
            name: "batched",
            steps: [
              { method: "GET", path: "/batch" },
              { method: "GET", path: "/fast" },
            ],
          },
        ],
        stages: [48],
        hold: "3s",
        settle: "300ms",
        timeout: "5s",
      },
      { safety },
    );
    const s = r.data!.stages[0]!;
    // Precondition (the reproduction): the GCRA did delay some requests.
    expect(s.throttled).toBeGreaterThan(0);
    expect(s.throughput).toBeLessThan(300);
    expect(s.capped).toBe(false);
    expect(r.data!.safetyCap).toBeUndefined();
    expect(r.limitations.find((l) => l.code === "STRESS-SAFETY-RATE-CAP")).toBeUndefined();
    // The short waits are still disclosed, naming the real limiter (burst tolerance), as informational.
    const burst = r.limitations.find((l) => l.code === "STRESS-SAFETY-BURST-SMOOTHED");
    expect(burst?.impact).toBe("informational");
    expect(burst?.message).toMatch(/burst/);
    expect(burst?.message).toMatch(/safety\.maxRps 500 req\/s/);
    expect(r.data!.capacity.limitedBySafetyCap).toBeUndefined();
  });
});
