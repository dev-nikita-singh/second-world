/**
 * Fixture for tests/integration/robust/double-sigint.test.ts: keeps report and history writes in flight
 * (the same primitives `finishRun` and the history store use) and drives the real Ctrl+C handler of
 * src/cli/run-common.ts with two SIGINTs after SW_TEST_SIGINT_AFTER_MS. The second one hard-exits 130.
 * argv: <outDir> <historyDir>
 */
import path from "node:path";
import { installSignals } from "../../../../src/cli/run-common.js";
import type { World } from "../../../../src/core/world.js";
import { atomicWrite, withLock } from "../../../../src/engines/history/index.js";
import { writeFileAtomic } from "../../../../src/shared/util/atomic-write.js";

const [outDir, historyDir] = process.argv.slice(2) as [string, string];
const world = {
  cancel: () => {},
  config: {
    cwd: process.cwd(),
    config: { report: { outDir, formats: ["json"] }, history: { dir: historyDir } },
  },
} as unknown as World;
installSignals(world, { quiet: true } as never);

const after = Number(process.env.SW_TEST_SIGINT_AFTER_MS ?? "50");
setTimeout(() => {
  process.emit("SIGINT", "SIGINT");
  process.emit("SIGINT", "SIGINT");
}, after);

const big = "x".repeat(4 * 1024 * 1024);
async function loop(): Promise<void> {
  for (let i = 0; ; i++) {
    await Promise.all([
      writeFileAtomic(path.join(outDir, "report.json"), big),
      writeFileAtomic(path.join(outDir, "report.md"), big),
      withLock(path.join(historyDir, ".lock"), () =>
        atomicWrite(path.join(historyDir, "runs", `r${i % 4}.json.gz`), big),
      ),
    ]);
  }
}
void loop();
