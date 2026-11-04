/**
 * Child process for the SQLite history concurrency / crash tests (tests/integration/history/sqlite.test.ts).
 * argv: <historyDir> <tag> <count (0 = until killed)> <padBytes>
 * Prints "appended <id>" after each committed append, "done" at the end, and every store warning
 * as "warning: <message>".
 */
import { randomBytes } from "node:crypto";
import { openHistoryStore } from "../../../../src/engines/history/index.js";

const [dir, tag = "w", countArg = "0", padArg = "0"] = process.argv.slice(2);
const count = Number(countArg);
const pad = Number(padArg);
const store = await openHistoryStore({
  dir: dir as string,
  backend: "sqlite",
  captureGit: false,
  onWarning: (m) => process.stdout.write(`warning: ${m}\n`),
});
process.stdout.write(`backend ${store.backend}\n`);
for (let n = 1; count === 0 || n <= count; n++) {
  const e = await store.append({
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
        data: {
          latency: { corrected: { p95: n } },
          totals: { rps: n, errorRate: 0, requests: n },
          ...(pad > 0 ? { pad: randomBytes(pad).toString("base64") } : {}),
        },
      } as never,
    ],
    label: tag,
    tags: [tag],
  });
  process.stdout.write(`appended ${e.id}\n`);
}
process.stdout.write("done\n");
