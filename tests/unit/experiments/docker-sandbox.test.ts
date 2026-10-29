/**
 * Docker sandbox argv (no daemon needed) and LF worktree checkout — fixes found by the live Docker
 * tests (tests/integration/docker). docs/03-engines/experiments.md §B.3, §B.5.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { bindMount, createDockerSandbox, SANDBOX_LABELS } from "../../../src/engines/experiments/sandbox.js";
import { WorktreeManager } from "../../../src/engines/experiments/worktree.js";

const opts = {
  image: "node:22-alpine",
  cpus: 1,
  memory: "256m",
  network: "none",
  user: "1000:1000",
  namePrefix: "sw-evolve",
  labels: { [SANDBOX_LABELS.sandbox]: "evolution", "io.second-world.run": "RUN1" },
};

describe("docker sandbox argv", () => {
  it("labels every container and bind-mounts with --mount (Windows drive letters are safe)", () => {
    const sb = createDockerSandbox(opts);
    const wt = "C:\\Users\\me\\AppData\\Local\\Temp\\sw-evo-abc\\baseline";
    const wrap = sb.wrapStart(wt, [{ host: "C:\\cache\\node_modules", container: "/work/node_modules" }]);
    const plan = wrap?.({ argv: ["node", "server.mjs"], cwd: wt, env: { PORT: "4321" } }, 4321);
    const argv = plan?.argv ?? [];
    const labels = argv.flatMap((a, i) => (argv[i - 1] === "--label" ? [a] : []));
    expect(labels).toEqual(
      expect.arrayContaining([
        `${SANDBOX_LABELS.owner}=second-world`,
        `${SANDBOX_LABELS.sandbox}=evolution`,
        `${SANDBOX_LABELS.pid}=${process.pid}`,
        "io.second-world.run=RUN1",
        expect.stringMatching(
          new RegExp(`^${SANDBOX_LABELS.instance.replace(/\./g, "\\.")}=${process.pid}-\\d+$`),
        ),
      ]),
    );
    expect(argv).not.toContain("-v");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--mount",
        `type=bind,source=${wt},target=/work`,
        "type=bind,source=C:\\cache\\node_modules,target=/work/node_modules,readonly",
        "-p",
        "127.0.0.1:4321:4321",
        "HOST=0.0.0.0",
        "PORT=4321",
      ]),
    );
    expect(argv.slice(-3)).toEqual(["node:22-alpine", "node", "server.mjs"]);
  });

  it("rejects mount paths containing a comma (would corrupt the --mount spec)", () => {
    expect(() => bindMount("C:\\a,b", "/work", false)).toThrow(/","/);
  });

  it("exposes prepare (image pull) and cleanup (sweep by instance label)", () => {
    const sb = createDockerSandbox(opts);
    expect(typeof sb.prepare).toBe("function");
    expect(typeof sb.cleanup).toBe("function");
  });
});

describe("WorktreeManager LF checkout", () => {
  let repo = "";
  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true, maxRetries: 5 });
  });

  it("checks out LF with { lf: true } even when core.autocrlf=true", async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "sw-lf-"));
    const git = (...a: string[]) =>
      execa(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@e.invalid", "-c", "commit.gpgsign=false", ...a],
        {
          cwd: repo,
          windowsHide: true,
        },
      );
    await git("init", "-q", "-b", "main");
    await git("config", "core.autocrlf", "true");
    await writeFile(path.join(repo, "check.sh"), "#!/bin/sh\nset -eu\necho ok\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "x");
    const commit = String((await git("rev-parse", "HEAD")).stdout).trim();

    const crlf = new WorktreeManager(repo, os.tmpdir());
    const a = await crlf.add("a", commit);
    expect(await readFile(path.join(a.dir, "check.sh"), "utf8")).toContain("\r\n");
    await crlf.cleanupAll();

    const lf = new WorktreeManager(repo, os.tmpdir(), { lf: true });
    const b = await lf.add("b", commit);
    expect(await readFile(path.join(b.dir, "check.sh"), "utf8")).toBe("#!/bin/sh\nset -eu\necho ok\n");
    expect(await lf.cleanupAll()).toBe(true);
  }, 30_000);
});
