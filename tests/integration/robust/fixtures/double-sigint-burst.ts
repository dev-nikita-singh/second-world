/**
 * Fixture for tests/integration/robust/double-sigint.test.ts ("burst"): many small concurrent report and
 * history writes on a 2-thread libuv pool, so at any moment some temp-creating fs requests are queued
 * behind others. The double Ctrl+C fires from a timer; the process must leave no temp or lock file.
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

// The clock starts at the first completed report write, so the abort always lands while the writers
// are busy, however slowly this process started (tsx transpile on a loaded CI runner).
const after = Number(process.env.SW_TEST_SIGINT_AFTER_MS ?? "50");
let armed = false;
function arm(): void {
  if (armed) return;
  armed = true;
  setTimeout(() => {
    process.emit("SIGINT", "SIGINT");
    process.emit("SIGINT", "SIGINT");
  }, after);
}

const small = "y".repeat(2048);
async function writer(w: number): Promise<void> {
  for (let i = 0; ; i++) {
    if (w % 2 === 0) {
      await writeFileAtomic(path.join(outDir, `report-${w}.json`), small);
      arm();
    } else
      await withLock(path.join(historyDir, ".lock"), () =>
        atomicWrite(path.join(historyDir, "runs", `r${w}-${i % 3}.json.gz`), small),
      );
  }
}
for (let w = 0; w < 24; w++) void writer(w);
