/**
 * Test entry for the `sw` CLI (tests/integration/concurrency). Same as src/cli/main.ts's entry, with two
 * differences that make lifecycle bugs visible:
 * - no forced process.exit after main() resolves: the process must exit on its own, so a leaked
 *   timer/socket/child handle shows up as a hang (prints "sw-entry: main returned <code>" first);
 * - Ctrl+C emulation: Windows cannot deliver SIGINT to a child, so the handler path is driven by
 *   `process.emit("SIGINT")` — after SW_TEST_SIGINT_AFTER_MS, or once SW_TEST_SIGINT_WHEN_FILE exists
 *   (`<dir>/*`: once the directory has an entry).
 *   SW_TEST_SIGINT_COUNT=2 sends a second one (hard abort).
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { main } from "../../../../src/cli/main.js";

const count = Number(process.env.SW_TEST_SIGINT_COUNT ?? "1");
function interrupt(): void {
  for (let i = 0; i < count; i++) setTimeout(() => process.emit("SIGINT", "SIGINT"), i * 5).unref();
}
const after = process.env.SW_TEST_SIGINT_AFTER_MS;
if (after) setTimeout(interrupt, Number(after)).unref();
const whenFile = process.env.SW_TEST_SIGINT_WHEN_FILE;
if (whenFile) {
  const t = setInterval(() => {
    const hit = whenFile.endsWith("*")
      ? existsSync(path.dirname(whenFile)) && readdirSync(path.dirname(whenFile)).length > 0
      : existsSync(whenFile);
    if (hit) {
      clearInterval(t);
      setTimeout(interrupt, Number(process.env.SW_TEST_SIGINT_DELAY_MS ?? "300")).unref();
    }
  }, 50);
  t.unref();
}

main(["node", "sw", ...process.argv.slice(2)]).then(
  (code) => {
    process.exitCode = code;
    process.stderr.write(`sw-entry: main returned ${code}\n`);
  },
  (e: unknown) => {
    process.stderr.write(`internal error: ${String(e)}\n`);
    process.exitCode = 70;
  },
);
