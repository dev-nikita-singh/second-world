/**
 * Child process for the live crash tests: applies ONE external fault (docker or toxiproxy) with a
 * given ledger, prints "APPLIED <id>", then hard-kills itself (SIGKILL / TerminateProcess) so no
 * in-process cleanup (signal hooks, exit hook, TTL timers) can run — only the ledger / watchdog remain.
 *
 * argv: <kind docker|toxiproxy> <ledgerPath> <faultJson> <watchdog 0|1> [toxiproxyApi] [proxy]
 */
import { DockerInjector } from "../../../../src/adapters/faults/docker.js";
import { ToxiproxyInjector } from "../../../../src/adapters/faults/toxiproxy.js";

const [kind, ledgerPath, faultJson, watchdog, api, proxy] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string | undefined,
  string | undefined,
];
const opts = { ledgerPath, watchdog: watchdog === "1" };
const inj =
  kind === "docker"
    ? new DockerInjector(opts)
    : new ToxiproxyInjector({ ...opts, apiUrl: api as string, proxy: proxy as string });
const applied = await inj.apply(JSON.parse(faultJson));
process.stdout.write(`APPLIED ${applied.id}\n`, () => {
  process.kill(process.pid, "SIGKILL");
});
