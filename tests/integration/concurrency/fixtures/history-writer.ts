/**
 * Child process for crash tests: appends large runs to a history dir in a loop, printing "appended <id>"
 * after each. The parent kills it (SIGKILL / TerminateProcess) at an arbitrary point.
 * argv: <historyDir> <tag>
 */
import { randomBytes } from "node:crypto";
import { createHistoryStore } from "../../../../src/engines/history/index.js";

const [dir, tag = "w"] = process.argv.slice(2);
const store = createHistoryStore({ dir: dir as string, captureGit: false });
let n = 0;
for (;;) {
  n++;
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
          totals: { rps: n, errorRate: 0, requests: n },
          pad: randomBytes(150_000 + n).toString("base64"),
        },
      } as never,
    ],
    label: tag,
  });
  process.stdout.write(`appended ${e.id}\n`);
}
