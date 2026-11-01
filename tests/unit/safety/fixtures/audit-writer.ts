/** Child process for audit-chain.test.ts: one guard appending N entries to a shared audit file. */
import { createSafetyGuard } from "../../../../src/core/safety/guard.js";

const [file, n, tag] = process.argv.slice(2) as [string, string, string];
const g = createSafetyGuard({}, { interactive: false, auditFile: file });
for (let i = 0; i < Number(n); i++) g.audit({ action: `${tag}.${i}`, detail: { i } });
