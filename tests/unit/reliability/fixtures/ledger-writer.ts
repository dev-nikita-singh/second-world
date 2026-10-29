/**
 * Child process for the concurrent-ledger test: hammers one ledger file with ledgerAdd / ledgerRemove.
 * argv: <ledgerPath> <tag> <n>. Adds `${tag}-${i}` for i < n and removes every even one right after
 * the next add, then prints "DONE".
 */
import { ledgerAdd, ledgerRemove } from "../../../../src/adapters/faults/cleanup.js";

const [ledgerPath, tag, n] = process.argv.slice(2) as [string, string, string];
for (let i = 0; i < Number(n); i++) {
  ledgerAdd(
    {
      id: `${tag}-${i}`,
      injector: "test",
      description: `entry ${i} of ${tag}`,
      createdAt: `2026-10-29T00:00:00.${String(i).padStart(3, "0")}Z`,
      expiresAt: 0,
      pid: process.pid,
      actions: [{ kind: "http", method: "DELETE", url: `http://127.0.0.1:1/${tag}/${i}` }],
    },
    ledgerPath,
  );
  if (i % 2 === 1) ledgerRemove(`${tag}-${i - 1}`, ledgerPath);
}
process.stdout.write("DONE\n");
