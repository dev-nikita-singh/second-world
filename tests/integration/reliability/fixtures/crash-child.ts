/**
 * Child process for the crash test: applies faults, then dies from an uncaught exception.
 * argv: <toxiproxyApiUrl> <ledgerPath> <watchdog:0|1> <ttlMs>
 */
import { startFaultProxy } from "../../../../src/adapters/faults/builtin-proxy.js";
import { ToxiproxyInjector } from "../../../../src/adapters/faults/toxiproxy.js";

const [apiUrl, ledgerPath, watchdog, ttl] = process.argv.slice(2);
const proxy = await startFaultProxy({ upstream: "http://127.0.0.1:9", name: "crash" });
await proxy.apply({ type: "blackhole" });
const inj = new ToxiproxyInjector({
  apiUrl: apiUrl as string,
  proxy: "payments",
  create: { listen: "127.0.0.1:0", upstream: "127.0.0.1:9" },
  ledgerPath: ledgerPath as string,
  watchdog: watchdog === "1",
});
await inj.apply({ type: "latency", latencyMs: 1000, id: "crash", ttlMs: Number(ttl) });
process.stdout.write(`READY ${proxy.port}\n`);
setTimeout(() => {
  throw new Error("simulated crash");
}, 50);
