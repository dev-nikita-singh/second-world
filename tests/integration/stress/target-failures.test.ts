/**
 * Stress against targets that fail every request (real sockets on 127.0.0.1:0): never answering →
 * exit 5 (nothing measured), 5xx / reset after connect → exit 1 (breach). Never 70 or 0.
 * docs/03-engines/stress-capacity-lab.md §7.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { computeVerdict } from "../../../src/engines/reporting/model.js";
import { runStress } from "../../../src/engines/stress/index.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let close: (() => Promise<void>) | null = null;

async function start(h: Handler): Promise<string> {
  const socks = new Set<Socket>();
  const s = createServer(h);
  s.on("connection", (c) => {
    socks.add(c);
    c.on("close", () => socks.delete(c));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  close = async () => {
    for (const c of socks) c.destroy();
    await new Promise<void>((r) => s.close(() => r()));
  };
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
}

afterEach(async () => {
  await close?.();
  close = null;
});

describe("stress: target fails every request (integration)", () => {
  it("server never responds (timeout longer than the stage) → no-measurements, exit 5", {
    timeout: 20_000,
  }, async () => {
    const url = await start(() => {});
    const r = await runStress({ target: url, stages: [2, 4], hold: "1s", settle: "0ms" });
    expect(r.status).toBe("error");
    expect(r.limitations.find((l) => l.code === "no-measurements")?.impact).toBe("invalidates");
    expect(computeVerdict([r]).exitCode).toBe(5);
  });

  it("server destroys every socket → breach, exit 1", { timeout: 20_000 }, async () => {
    const url = await start((req) => req.socket.destroy());
    const r = await runStress({ target: url, stages: [2, 4], hold: "1s", settle: "0ms", timeout: "500ms" });
    expect(r.status).toBe("failed");
    expect(r.data!.firstBreach).not.toBeNull();
    expect(computeVerdict([r]).exitCode).toBe(1);
  });

  it("server answers 500 to everything → breach, exit 1", { timeout: 20_000 }, async () => {
    const url = await start((_req, res) => {
      res.statusCode = 500;
      res.end("no");
    });
    const r = await runStress({ target: url, stages: [2, 4], hold: "1s", settle: "0ms" });
    expect(r.status).toBe("failed");
    expect(computeVerdict([r]).exitCode).toBe(1);
  });
});
