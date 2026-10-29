import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

// Regression: `--dry-run` printed resolved {env}/{file} secrets (docs/11 §4: every resolved
// config secret is in the redaction deny-set, including dry-run plans).
const SECRET = "s3cr3t-Zq9vX2pL7wK4";

describe("--dry-run never prints resolved secrets", () => {
  let dir: TmpDir;
  beforeAll(async () => {
    dir = await makeTmpDir("sw-dryrun-");
    const config = {
      targets: { api: { url: "http://127.0.0.1:3000" } },
      auth: { user: { type: "bearer", token: { env: "MY_SECRET_TOKEN" } } },
      performance: { auth: "user", scenarios: [{ name: "a", steps: [{ method: "GET", path: "/healthz" }] }] },
      stress: { mode: "step", stages: [1, 2], hold: "1s" },
    };
    await writeFile(join(dir.path, "sw.config.json"), JSON.stringify(config));
  });
  afterAll(() => dir.cleanup());

  const env = () => ({ MY_SECRET_TOKEN: SECRET, SW_USER_CONFIG_DIR: dir.join("no-user-config") });

  it.each([
    ["perf --json", ["--dry-run", "perf", "--json"]],
    ["perf (tty)", ["--dry-run", "perf"]],
    ["stress --json", ["--dry-run", "stress", "--json"]],
    ["stress (tty)", ["--dry-run", "stress"]],
  ])("%s", async (_name, args) => {
    const r = await runCli(args, { cwd: dir.path, env: env(), timeoutMs: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("dry");
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });
});
