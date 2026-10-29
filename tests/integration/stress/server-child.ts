/**
 * Child-process entry: starts the calibrated server and prints {"url": ...} on stdout.
 * Running the target out of process keeps its CPU (precise-timer spin) out of the
 * generator's self-check. Exits when stdin closes.
 */
import { startCalibratedServer } from "../../fixtures/servers/calibrated.js";

const srv = await startCalibratedServer();
process.stdout.write(`${JSON.stringify({ url: srv.url })}\n`);
const stop = async (): Promise<void> => {
  await srv.close();
  process.exit(0);
};
process.stdin.on("end", () => void stop());
process.stdin.on("close", () => void stop());
process.stdin.resume();
