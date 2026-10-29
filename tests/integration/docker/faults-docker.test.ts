/**
 * LIVE: reliability Docker fault injector (src/adapters/faults/docker.ts) against the real daemon.
 * docs/03-engines/reliability-lab.md §1 and docs/11-safety-security-privacy.md §1 (leftover faults).
 *
 * A throw-away labelled container (tiny HTTP server, published on 127.0.0.1) on a throw-away labelled
 * network is the "dependency". For every container action the injector implements (pause, stop,
 * restart, network-disconnect) the test checks the fault is really applied (docker state + HTTP) and
 * really reverted, and that the persistent ledger tracks it. Crash safety: a child process applies a
 * fault and is hard-killed; `sw reliability cleanup --ledger` (the real CLI) and the detached watchdog
 * must revert it. Skipped without Docker.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupAll, readLedger, spawnWatchdog } from "../../../src/adapters/faults/cleanup.js";
import { DockerInjector } from "../../../src/adapters/faults/docker.js";
import { REPO_ROOT, runCli } from "../../helpers/cli.js";
import {
  docker,
  dockerAvailable,
  ensureImage,
  inspect,
  publishedPort,
  removeLabelled,
  TEST_LABEL,
  waitFor,
} from "./helpers.js";

const IMAGE = "node:22-alpine";
const NAME = `sw-test-dep-${process.pid}`;
const NET = `sw-test-net-${process.pid}`;
const TSX = pathToFileURL(path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const CHILD = path.join(import.meta.dirname, "fixtures", "fault-crash-child.ts");
const SERVER = `require("http").createServer((q, s) => s.end("pong " + process.pid)).listen(8080, "0.0.0.0")`;

let dir = "";
let ledger = "";

async function get(timeoutMs = 1500): Promise<string | null> {
  try {
    const port = await publishedPort(NAME, 8080);
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}
const healthy = () => waitFor(async () => (await get())?.startsWith("pong") ?? false, 20_000);
const state = async () => ({
  running: (await inspect(NAME, "{{.State.Running}}")) === "true",
  paused: (await inspect(NAME, "{{.State.Paused}}")) === "true",
});
const networks = async () =>
  JSON.parse((await inspect(NAME, "{{json .NetworkSettings.Networks}}")) ?? "{}") as object;

async function crashChild(fault: object, watchdog: boolean): Promise<string> {
  const r = await execa(
    process.execPath,
    ["--import", TSX, CHILD, "docker", ledger, JSON.stringify(fault), watchdog ? "1" : "0"],
    { cwd: REPO_ROOT, reject: false, timeout: 60_000, windowsHide: true },
  );
  const m = /APPLIED (\S+)/.exec(String(r.stdout));
  if (!m) throw new Error(`child did not apply: ${r.stdout} ${r.stderr}`);
  expect(r.exitCode).not.toBe(0); // hard-killed, no in-process cleanup
  return m[1] as string;
}

describe.skipIf(!dockerAvailable)("LIVE docker fault injector", () => {
  beforeAll(async () => {
    await ensureImage(IMAGE, 600_000);
    dir = mkdtempSync(path.join(tmpdir(), "sw-dkr-faults-"));
    ledger = path.join(dir, "ledger.json");
    await removeLabelled(TEST_LABEL); // leftovers of an earlier interrupted run of these tests
    await docker(["network", "create", "--label", TEST_LABEL, NET], { reject: true });
    await docker(
      [
        "run",
        "-d",
        "--name",
        NAME,
        "--label",
        TEST_LABEL,
        "--network",
        NET,
        "-p",
        "127.0.0.1::8080",
        IMAGE,
        "node",
        "-e",
        SERVER,
      ],
      { reject: true },
    );
    expect(await healthy()).toBe(true);
  }, 660_000);

  afterAll(async () => {
    // Only what this file created (label + our names); never prune.
    await docker(["unpause", NAME]);
    await removeLabelled(TEST_LABEL);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("capabilities: available, container faults only", async () => {
    const caps = await new DockerInjector({ ledgerPath: ledger, watchdog: false }).capabilities();
    expect(caps).toMatchObject({ available: true, faults: ["container"] });
  });

  it("pause: requests hang while paused, answered after revert; ledger tracks it", async () => {
    const inj = new DockerInjector({ ledgerPath: ledger, watchdog: false });
    const f = await inj.apply({ type: "container", action: "pause", container: NAME });
    expect(await state()).toEqual({ running: true, paused: true });
    expect(readLedger(ledger).map((e) => e.id)).toEqual([f.id]);
    expect(await get(1000)).toBeNull();
    await f.revert();
    expect(await state()).toEqual({ running: true, paused: false });
    expect(await healthy()).toBe(true);
    expect(readLedger(ledger)).toEqual([]);
    expect(inj.active()).toEqual([]);
  }, 60_000);

  it("stop: container down during the fault, started again on revert", async () => {
    const inj = new DockerInjector({ ledgerPath: ledger, watchdog: false });
    const f = await inj.apply({ type: "container", action: "stop", container: NAME });
    expect((await state()).running).toBe(false);
    expect(await get(1000)).toBeNull();
    await inj.revert(f.id);
    expect((await state()).running).toBe(true);
    expect(await healthy()).toBe(true);
    expect(readLedger(ledger)).toEqual([]);
  }, 60_000);

  it("restart: the process restarts (new pid / StartedAt), revert leaves it running", async () => {
    const before = await inspect(NAME, "{{.State.StartedAt}}");
    const inj = new DockerInjector({ ledgerPath: ledger, watchdog: false });
    const f = await inj.apply({ type: "container", action: "restart", container: NAME });
    expect(await inspect(NAME, "{{.State.StartedAt}}")).not.toBe(before);
    await f.revert(); // `docker start` on a running container is a no-op
    expect((await state()).running).toBe(true);
    expect(await healthy()).toBe(true);
    expect(readLedger(ledger)).toEqual([]);
  }, 60_000);

  it("network-disconnect: detached from the network during the fault, reconnected on revert", async () => {
    const inj = new DockerInjector({ ledgerPath: ledger, watchdog: false });
    expect(Object.keys(await networks())).toContain(NET);
    const f = await inj.apply({
      type: "container",
      action: "network-disconnect",
      container: NAME,
      network: NET,
    });
    expect(Object.keys(await networks())).not.toContain(NET);
    await f.revert();
    expect(Object.keys(await networks())).toContain(NET);
    expect(await healthy()).toBe(true);
    expect(readLedger(ledger)).toEqual([]);
  }, 60_000);

  it("refuses to stop a --rm container (stop would delete it; the revert could never restore it)", async () => {
    const rmName = `${NAME}-rm`;
    await docker(
      ["run", "-d", "--rm", "--name", rmName, "--label", TEST_LABEL, IMAGE, "node", "-e", SERVER],
      { reject: true },
    );
    try {
      const inj = new DockerInjector({ ledgerPath: ledger, watchdog: false });
      await expect(inj.apply({ type: "container", action: "stop", container: rmName })).rejects.toThrow(
        /--rm/,
      );
      expect(await inspect(rmName, "{{.State.Running}}")).toBe("true");
      expect(readLedger(ledger)).toEqual([]);
      // pause stays allowed
      const f = await inj.apply({ type: "container", action: "pause", container: rmName });
      expect(await inspect(rmName, "{{.State.Paused}}")).toBe("true");
      await f.revert();
      expect(await inspect(rmName, "{{.State.Paused}}")).toBe("false");
    } finally {
      await docker(["rm", "-f", rmName]);
    }
  }, 60_000);

  it("abort signal reverts the fault", async () => {
    const inj = new DockerInjector({ ledgerPath: ledger, watchdog: false });
    const ac = new AbortController();
    await inj.apply({ type: "container", action: "pause", container: NAME }, ac.signal);
    expect((await state()).paused).toBe(true);
    ac.abort();
    expect(await waitFor(async () => !(await state()).paused, 15_000)).toBe(true);
    expect(await waitFor(async () => readLedger(ledger).length === 0, 5_000)).toBe(true);
  }, 60_000);

  it("in-process TTL reverts the fault on its own", async () => {
    const inj = new DockerInjector({ ledgerPath: ledger, watchdog: false });
    await inj.apply({ type: "container", action: "pause", container: NAME, ttlMs: 1500 });
    expect((await state()).paused).toBe(true);
    expect(await waitFor(async () => !(await state()).paused, 15_000)).toBe(true);
    expect(await waitFor(async () => readLedger(ledger).length === 0, 5_000)).toBe(true);
    expect(inj.active()).toEqual([]);
  }, 60_000);

  it("crash: hard-killed process leaves the container paused; `sw reliability cleanup --ledger` reverts it", async () => {
    const id = await crashChild({ type: "container", action: "pause", container: NAME }, false);
    expect((await state()).paused).toBe(true);
    expect(readLedger(ledger).map((e) => e.id)).toEqual([id]);
    const r = await runCli(["reliability", "cleanup", "--ledger", ledger, "--json"], { timeoutMs: 60_000 });
    console.log(`$ sw reliability cleanup --ledger <tmp>/ledger.json --json\n${r.stdout}${r.stderr}`);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ledger: 1, errors: [] });
    expect((await state()).paused).toBe(false);
    expect(readLedger(ledger)).toEqual([]);
    expect(await healthy()).toBe(true);
  }, 120_000);

  it("crash: stop fault is restarted by cleanupAll() from the ledger", async () => {
    await crashChild({ type: "container", action: "stop", container: NAME }, false);
    expect((await state()).running).toBe(false);
    const res = await cleanupAll({ ledgerPath: ledger });
    expect(res.errors).toEqual([]);
    expect((await state()).running).toBe(true);
    expect(await healthy()).toBe(true);
    expect(readLedger(ledger)).toEqual([]);
  }, 120_000);

  it("ledger cleanup of a fault that was already reverted by someone else succeeds and clears the entry", async () => {
    await crashChild({ type: "container", action: "pause", container: NAME }, false);
    await docker(["unpause", NAME], { reject: true }); // e.g. the operator or the watchdog got there first
    const res = await cleanupAll({ ledgerPath: ledger });
    expect(res.errors).toEqual([]);
    expect(readLedger(ledger)).toEqual([]);
    expect((await state()).paused).toBe(false);
  }, 120_000);

  it("crash: the detached watchdog unpauses after the TTL without any cleanup call", async () => {
    await crashChild({ type: "container", action: "pause", container: NAME, ttlMs: 2000 }, true);
    expect((await state()).paused).toBe(true);
    expect(await waitFor(async () => !(await state()).paused, 30_000, 250)).toBe(true);
    // the ledger entry stays until a cleanup run sees it is already reverted
    const res = await cleanupAll({ ledgerPath: ledger });
    expect(res.errors).toEqual([]);
    expect(readLedger(ledger)).toEqual([]);
  }, 120_000);

  it("spawnWatchdog runs a real docker revert action", async () => {
    await docker(["pause", NAME], { reject: true });
    const disarm = spawnWatchdog(500, [{ kind: "exec", file: "docker", args: ["unpause", NAME] }]);
    expect(await waitFor(async () => !(await state()).paused, 30_000, 250)).toBe(true);
    disarm();
  }, 60_000);
});
