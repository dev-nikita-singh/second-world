/**
 * LIVE: Evolution with sandbox "docker" against the real daemon (docs/03-engines/experiments.md §B.3, §B.5).
 * A throw-away git repo (Node HTTP app + `npm test` with a zero-dependency lockfile) is created with
 * the machine's default line-ending config (on Windows usually core.autocrlf=true, so a shell script
 * in the repo is checked out with CRLF unless the sandbox forces LF).
 *
 * Proves: install/test gates run inside containers (the test script fails outside a container), the
 * app container is reachable from the host (health is 503 outside a container), candidates are ranked,
 * and every sandbox container is gone afterwards (by the labels the sandbox sets). Skipped without Docker.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEvolution, workingTreeChecksum } from "../../../src/engines/experiments/index.js";
import {
  containersWithLabel,
  dockerAvailable,
  ensureImage,
  networksWithLabel,
  removeLabelled,
  TEST_LABEL,
} from "./helpers.js";

const IMAGE = "node:22-alpine";
/** Set by the sandbox on every container it creates (+ io.second-world.pid). */
const SANDBOX_LABEL = "io.second-world.sandbox=evolution";
const PID_LABEL = `io.second-world.pid=${process.pid}`;

const SERVER = `import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
// /.dockerenv (Docker) or /run/.containerenv (Podman), the same check as src/core/probe.
const inContainer = existsSync("/.dockerenv") || existsSync("/run/.containerenv");
const { delayMs } = JSON.parse(readFileSync(new URL("./delay.json", import.meta.url), "utf8"));
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.statusCode = inContainer ? 200 : 503; res.end(inContainer ? "ok " + os.hostname() : "not in a container"); return; }
  const done = () => res.end("work");
  if (delayMs > 0) setTimeout(done, delayMs); else setImmediate(done);
});
server.listen(Number(process.env.PORT ?? 0), process.env.HOST ?? "127.0.0.1");
`;

const TEST = `import { existsSync } from "node:fs";
if (!existsSync("/.dockerenv") && !existsSync("/run/.containerenv")) { console.error("tests must run inside the docker sandbox"); process.exit(1); }
console.log("unit tests passed in container", process.platform, process.arch);
`;

// Multi-line POSIX script: with CRLF line endings, "set -eu\\r" fails in /bin/sh.
const CHECK = '#!/bin/sh\nset -eu\nname=check\necho "$name ok"\n';

const PKG = {
  name: "tiny-evo",
  version: "1.0.0",
  private: true,
  type: "module",
  scripts: { test: "node test.mjs && sh check.sh", start: "node server.mjs" },
};
const LOCK = {
  name: "tiny-evo",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: { "": { name: "tiny-evo", version: "1.0.0" } },
};

let dir = "";
const git = async (...args: string[]) =>
  String(
    (
      await execa(
        "git",
        [
          "-c",
          "user.name=SW Test",
          "-c",
          "user.email=sw@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: dir, windowsHide: true },
      )
    ).stdout,
  ).trim();

async function createRepo(): Promise<void> {
  dir = await mkdtemp(path.join(os.tmpdir(), "sw-dkr-repo-"));
  await git("init", "-q", "-b", "main");
  const files: Record<string, string> = {
    "server.mjs": SERVER,
    "test.mjs": TEST,
    "check.sh": CHECK,
    "delay.json": JSON.stringify({ delayMs: 30 }),
    "package.json": `${JSON.stringify(PKG, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify(LOCK, null, 2)}\n`,
  };
  for (const [f, c] of Object.entries(files)) await writeFile(path.join(dir, f), c);
  await git("add", "-A");
  await git("commit", "-q", "-m", "baseline");
  const branch = async (name: string, delayMs: number) => {
    await git("checkout", "-q", "-b", name, "main");
    await writeFile(path.join(dir, "delay.json"), JSON.stringify({ delayMs }));
    await git("commit", "-q", "-am", name);
    await git("checkout", "-q", "main");
  };
  await branch("fix/fast", 0);
  await branch("fix/slower", 90);
  // leave the user's tree dirty: it must stay byte-identical
  await writeFile(path.join(dir, "notes.txt"), "untracked user notes\n");
}

describe.skipIf(!dockerAvailable)("LIVE Evolution docker sandbox", () => {
  beforeAll(async () => {
    await ensureImage(IMAGE, 600_000);
    await createRepo();
  }, 660_000);

  afterAll(async () => {
    await removeLabelled(PID_LABEL);
    await removeLabelled(TEST_LABEL);
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, 120_000);

  it("runs gates and apps in labelled containers, ranks 2 candidates × 2 reps, removes every container", async () => {
    const before = await workingTreeChecksum(dir);
    // Sample sandbox containers while the run is in progress.
    const seen = new Set<string>();
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        for (const c of await containersWithLabel(PID_LABEL)) seen.add(c);
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    const res = await runEvolution(
      {
        repo: dir,
        candidates: ["branch:fix/fast", "branch:fix/slower"],
        install: { strategy: "link" },
        test: ["npm", "test"],
        start: ["node", "server.mjs"],
        readyWhen: { path: "/healthz", timeout: "60s", interval: 250 },
        workload: {
          vus: 2,
          duration: "1s",
          warmup: "200ms",
          scenarios: [{ name: "w", steps: [{ path: "/work" }] }],
        },
        metrics: ["p50", "p95", "rps"],
        rankBy: ["p95"],
        design: { repetitions: 2, seed: 3 },
        sandbox: { kind: "docker", image: IMAGE, cpus: 1, memory: "256m" },
        gateTimeout: "180s",
      },
      {},
    ).finally(() => {
      sampling = false;
    });
    await sampler;
    const d = res.data!;
    console.log(
      `status=${res.status} sandbox=${JSON.stringify(d.sandbox)} containers seen=${seen.size}\n` +
        d.candidates
          .map(
            (c) =>
              `${c.name} ${c.status} rank=${c.rank ?? "-"} p95=${c.medians.p95?.toFixed(2)} gates=${c.gates
                .map(
                  (g) => `${g.name}:${g.ok ? "ok" : "FAIL"}${g.detail ? `(${g.detail.slice(0, 120)})` : ""}`,
                )
                .join(", ")} ${c.rejectionReasons.join("; ")}`,
          )
          .join("\n") +
        `\nlimitations=${res.limitations.map((l) => l.code).join(",")}`,
    );

    expect(d.sandbox.kind).toBe("docker");
    // gates ran (and could only pass) inside containers
    for (const c of d.candidates) {
      expect(c.rejectionReasons).toEqual([]);
      expect(c.status).toBe("accepted");
      const names = c.gates.map((g) => `${g.gate}:${g.ok}`);
      expect(names).toEqual(expect.arrayContaining(["install:true", "test:true", "benchmark:true"]));
    }
    expect(d.install.installed + d.install.reused).toBeGreaterThanOrEqual(3);
    // the app (health 503 outside a container) was reachable from the host for every run
    const runs = d.experiment?.runs ?? [];
    expect(runs.length).toBe(3 * 2);
    expect(runs.every((r) => r.status === "ok")).toBe(true);
    // ranked
    const fast = d.candidates.find((c) => c.name === "fix/fast")!;
    const slower = d.candidates.find((c) => c.name === "fix/slower")!;
    expect(new Set([fast.rank, slower.rank])).toEqual(new Set([1, 2]));
    expect(d.candidates.map((c) => c.name)).toEqual(
      [...d.candidates].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).map((c) => c.name),
    );
    expect(fast.medians.p95!).toBeLessThan(slower.medians.p95!);
    // containers were really used, and all are gone now
    expect(seen.size).toBeGreaterThanOrEqual(3);
    expect([...seen].every((n) => n.startsWith("sw-evolve-"))).toBe(true);
    expect(await containersWithLabel(PID_LABEL)).toEqual([]);
    expect(await containersWithLabel(SANDBOX_LABEL).then((l) => l.filter((n) => seen.has(n)))).toEqual([]);
    expect(await networksWithLabel(PID_LABEL)).toEqual([]);
    // user tree untouched, worktrees removed
    expect(d.workingTree.unchanged).toBe(true);
    expect(await workingTreeChecksum(dir)).toBe(before);
    expect(d.worktreesCleaned).toBe(true);
  }, 600_000);

  it("cancelling mid-run removes the running container", async () => {
    const ac = new AbortController();
    const seen = new Set<string>();
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const cs = await containersWithLabel(PID_LABEL);
        for (const c of cs) seen.add(c);
        if (cs.length > 0 && !ac.signal.aborted) ac.abort();
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    const res = await runEvolution(
      {
        repo: dir,
        candidates: ["branch:fix/fast"],
        install: { strategy: "none" },
        // a long gate: cancelled while its container runs
        test: ["node", "-e", "setTimeout(() => {}, 120000)"],
        start: ["node", "server.mjs"],
        sandbox: { kind: "docker", image: IMAGE, cpus: 1, memory: "256m" },
        gateTimeout: "150s",
      },
      { signal: ac.signal },
    ).finally(() => {
      sampling = false;
    });
    await sampler;
    expect(res.status).toBe("cancelled");
    expect(seen.size).toBeGreaterThanOrEqual(1);
    expect(await containersWithLabel(PID_LABEL)).toEqual([]);
    expect(res.data?.worktreesCleaned).toBe(true);
  }, 240_000);
});
