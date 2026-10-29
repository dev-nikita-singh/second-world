/**
 * Child-process entry for `startCalibratedServerInChild()` (see calibrated-child.ts).
 * argv[2] = JSON CalibratedServerOptions. Protocol over stdio, one JSON object per line:
 *   child → parent first line: {"ready":true,"url":...,"port":...}
 *   parent → child: {"id":n,"op":"stats"|"resetStats"|"setBehavior"|"stallFor"|"close","args":[...]}
 *   child → parent: {"id":n,"ok":true,"value":...} | {"id":n,"ok":false,"error":"..."}
 * The child exits when stdin closes (parent died or called close()).
 */
import { createInterface } from "node:readline";
import { type CalibratedServerOptions, startCalibratedServer } from "./calibrated.js";

const opts = JSON.parse(process.argv[2] ?? "{}") as CalibratedServerOptions;
const srv = await startCalibratedServer(opts);
const send = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};
send({ ready: true, url: srv.url, port: srv.port });

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await srv.close();
  process.exit(0);
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req: { id: number; op: string; args?: unknown[] };
  try {
    req = JSON.parse(line) as typeof req;
  } catch {
    return;
  }
  const args = req.args ?? [];
  try {
    switch (req.op) {
      case "stats":
        send({ id: req.id, ok: true, value: srv.stats() });
        return;
      case "resetStats":
        srv.resetStats();
        break;
      case "setBehavior":
        srv.setBehavior(args[0] as Parameters<typeof srv.setBehavior>[0]);
        break;
      case "stallFor":
        srv.stallFor(args[0] as number, args[1] as { allRoutes?: boolean } | undefined);
        break;
      case "close":
        send({ id: req.id, ok: true });
        void stop();
        return;
      default:
        throw new Error(`unknown op ${req.op}`);
    }
    send({ id: req.id, ok: true });
  } catch (e) {
    send({ id: req.id, ok: false, error: String(e) });
  }
});
rl.on("close", () => void stop());
