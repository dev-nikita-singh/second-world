/**
 * `sw replay` on an artifact naming an invariant module outside the project (threat model T6):
 * the CLI prints the "outside the project" reason, exits 2 (inconclusive, never 70) and never imports it.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir;
let server: Server;
let url = "";
const FP = "abcdef0123456789";

beforeAll(async () => {
  tmp = await makeTmpDir("sw-sec-replay-");
  server = createServer((_q, r) => r.end("{}"));
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const project = tmp.join("project");
  const elsewhere = tmp.join("elsewhere");
  await mkdir(join(project, ".second-world", "artifacts", "run1"), { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  const marker = join(elsewhere, "pwned.txt");
  await writeFile(
    join(elsewhere, "evil.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport default () => true;\n`,
  );
  await writeFile(
    join(project, "sw.config.json"),
    JSON.stringify({ $schemaVersion: 1, targets: { api: { url } }, safety: { allowHosts: ["127.0.0.1"] } }),
  );
  await writeFile(
    join(project, ".second-world", "artifacts", "run1", `bugs-${FP}.json`),
    JSON.stringify({
      fingerprint: FP,
      ruleId: "bugs/invariant-violated",
      operation: "GET /x",
      seed: 1,
      case: {
        technique: "invariants",
        operation: "GET /x",
        seed: 1,
        steps: [
          {
            request: { operation: "GET /x", method: "GET", path: "/x", secured: false, role: null },
            expect: "any",
          },
        ],
        check: { kind: "invariants" },
        context: {
          version: 1,
          roles: [],
          assertions: [],
          invariants: [{ module: join(elsewhere, "evil.mjs") }],
        },
      },
      exchanges: [],
      curl: [],
      message: "m",
    }),
  );
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await tmp?.cleanup();
});

describe("sw replay: invariant module outside the project", () => {
  it("prints the reason, exits 2 and never runs the module", async () => {
    const r = await runCli(["replay", FP.slice(0, 8), "--target", url], {
      cwd: tmp.join("project"),
      timeoutMs: 60_000,
    });
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/outside the project/);
    expect(r.exitCode).toBe(2);
    expect(existsSync(tmp.join("elsewhere", "pwned.txt"))).toBe(false);
  }, 90_000);
});
