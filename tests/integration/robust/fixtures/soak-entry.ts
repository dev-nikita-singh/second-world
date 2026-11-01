/**
 * Fixture for tests/integration/robust/soak.test.ts: runs the `sw` CLI in this process and samples its
 * own memory every SW_SOAK_SAMPLE_MS (default 5000) as `soak-sample {"t":…,"rss":…,"heap":…}` lines on
 * stderr. The process then exits on its own (exit code = main's).
 */
import { main } from "../../../../src/cli/main.js";

const every = Number(process.env.SW_SOAK_SAMPLE_MS ?? "5000");
const t0 = performance.now();
function sample(): void {
  const m = process.memoryUsage();
  process.stderr.write(
    `soak-sample ${JSON.stringify({ t: Math.round((performance.now() - t0) / 1000), rss: m.rss, heap: m.heapUsed, ext: m.external })}\n`,
  );
}
const timer = setInterval(sample, every);
timer.unref();
sample();

main(["node", "sw", ...process.argv.slice(2)]).then(
  (code) => {
    sample();
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`internal error: ${String(e)}\n`);
    process.exitCode = 70;
  },
);
