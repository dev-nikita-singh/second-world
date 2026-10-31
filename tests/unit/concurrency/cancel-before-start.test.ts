/**
 * Ctrl+C that arrives before an engine has reserved its safety lease (e.g. while `sw bugs` loads the
 * contract) is a cancellation (exit 130), not a safety kill (exit 3). Plan wave 7 §A; docs/09 §1.
 * Found by tests/integration/concurrency/lifecycle.test.ts ("bugs: exit 130").
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reportError } from "../../../src/cli/output.js";
import { ExitCode } from "../../../src/core/errors.js";
import { createWorld } from "../../../src/core/world.js";
import { REPO_ROOT } from "../../helpers/cli.js";

const CONTRACT = path.join(REPO_ROOT, "examples", "shop-express", "openapi.yaml");
const cases: [string, Record<string, unknown>][] = [
  ["bugs", { openapi: CONTRACT, techniques: ["contract"] }],
  ["agent", { openapi: CONTRACT }],
  ["performance", { target: "http://127.0.0.1:9/x", duration: "1s", rate: 5 }],
  ["stress", { target: "http://127.0.0.1:9/x", stages: [2, 4] }],
];

describe("world.cancel before an engine starts", () => {
  it.each(cases)(
    "%s: cancelled result or an error that maps to exit 130 (never SW_SAFETY_KILLED / exit 3)",
    async (engine, input) => {
      const world = await createWorld({
        probe: false,
        auditFile: false,
        userConfig: false,
        config: {
          targets: { api: { url: "http://127.0.0.1:9" } },
          safety: { allowHosts: ["127.0.0.1"] },
          history: { enabled: false },
        },
      });
      try {
        world.cancel(new Error("interrupted"));
        const handle = (world as unknown as Record<string, { run(i: unknown): Promise<{ status: string }> }>)[
          engine
        ]!;
        const err = await handle.run(input).then(
          (r) => {
            expect(r.status).toBe("cancelled");
            return undefined;
          },
          (e: unknown) => e,
        );
        // either a cancelled result (resolved) or an error that maps to exit 130
        if (err !== undefined) {
          const write = process.stderr.write;
          process.stderr.write = (() => true) as typeof process.stderr.write;
          try {
            expect(reportError(err), String((err as Error).message)).toBe(ExitCode.Cancelled);
          } finally {
            process.stderr.write = write;
          }
        }
      } finally {
        await world.close();
      }
    },
  );
});
