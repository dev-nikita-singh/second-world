/**
 * Fixture for tests/integration/robust/lock-contention.test.ts: appends <count> runs to one history dir
 * through the real store (lock + retries) and prints one JSON line {ok, failed, maxMs, totalMs}.
 * argv: <historyDir> <tag> <count>
 */
import { createHistoryStore } from "../../../../src/engines/history/index.js";

const [dir, tag = "w", countArg = "10"] = process.argv.slice(2);
const store = createHistoryStore({ dir: dir as string, captureGit: false });
let ok = 0;
let failed = 0;
let maxMs = 0;
const t0 = performance.now();
for (let n = 1; n <= Number(countArg); n++) {
  const t = performance.now();
  try {
    await store.append({
      results: [
        {
          schemaVersion: 1,
          engine: "performance",
          runId: `${tag}-${n}`,
          status: "passed",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
          findings: [],
          limitations: [],
          artifacts: [],
          data: { totals: { rps: n, errorRate: 0, requests: n } },
        } as never,
      ],
      label: tag,
    });
    ok++;
  } catch (e) {
    failed++;
    process.stderr.write(`${String(e)}\n`);
  }
  maxMs = Math.max(maxMs, performance.now() - t);
}
process.stdout.write(
  `${JSON.stringify({ ok, failed, maxMs: Math.round(maxMs), totalMs: Math.round(performance.now() - t0) })}\n`,
);
