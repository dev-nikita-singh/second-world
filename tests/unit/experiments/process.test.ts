import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { systemClock } from "../../../src/core/clock.js";
import { startApp } from "../../../src/engines/experiments/app.js";
import { isAlive, killTree, runCommand, splitCommand } from "../../../src/engines/experiments/command.js";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "experiments");
const ready = { path: "/healthz", timeoutMs: 10_000, intervalMs: 50 };

async function waitDead(pids: number[], ms = 8000): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (pids.every((p) => !isAlive(p))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pids.every((p) => !isAlive(p));
}

describe("splitCommand", () => {
  it("splits without a shell; keeps Windows backslashes", () => {
    expect(splitCommand('node "my app.js" --x=1')).toEqual(["node", "my app.js", "--x=1"]);
    expect(splitCommand("node C:\\app\\x.js")).toEqual(["node", "C:\\app\\x.js"]);
    expect(splitCommand(`a 'b c' "d \\"e\\"" ""`)).toEqual(["a", "b c", 'd "e"', ""]);
    expect(() => splitCommand('a "b')).toThrow(/Unterminated/);
  });
});

describe("process tree kill", () => {
  it("kills a child and its grandchild", async () => {
    const child = execa(process.execPath, [path.join(FIX, "spawn-tree.mjs")], {
      reject: false,
      buffer: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const line = await new Promise<string>((resolve, reject) => {
      let buf = "";
      child.stdout?.on("data", (b: Buffer) => {
        buf += b.toString();
        if (buf.includes("\n")) resolve(buf);
      });
      setTimeout(() => reject(new Error("no output")), 10_000);
    });
    const m = /child (\d+) grandchild (\d+)/.exec(line);
    expect(m).not.toBeNull();
    const pids = [Number(m![1]), Number(m![2])];
    expect(pids.every(isAlive)).toBe(true);
    await killTree(child.pid);
    await child;
    expect(await waitDead(pids)).toBe(true);
  });

  it("runCommand kills the tree on timeout", async () => {
    const r = await runCommand([process.execPath, path.join(FIX, "spawn-tree.mjs")], {
      cwd: FIX,
      timeoutMs: 1500,
    });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    const m = /child (\d+) grandchild (\d+)/.exec(r.stdout);
    expect(m).not.toBeNull();
    expect(await waitDead([Number(m![1]), Number(m![2])])).toBe(true);
  });

  it("runCommand reports exit codes and spawn errors", async () => {
    const ok = await runCommand([process.execPath, "-e", "process.stdout.write('hi')"], { cwd: FIX });
    expect(ok).toMatchObject({ ok: true, exitCode: 0, stdout: "hi" });
    const bad = await runCommand([process.execPath, "-e", "process.exit(4)"], { cwd: FIX });
    expect(bad).toMatchObject({ ok: false, exitCode: 4 });
    const missing = await runCommand(["definitely-not-a-command-xyz"], { cwd: FIX });
    expect(missing.ok).toBe(false);
  });
});

describe("startApp", () => {
  it("injects a free PORT, waits for health, stops the tree", async () => {
    const app = await startApp({
      command: [process.execPath, "tiny-server.mjs"],
      cwd: FIX,
      env: { START_DELAY_MS: "300" },
      readyWhen: ready,
      clock: systemClock,
    });
    expect(app.port).toBeGreaterThan(0);
    const res = await fetch(`${app.url}/healthz`);
    expect(res.status).toBe(200);
    const pid = app.pid!;
    await app.stop();
    expect(await waitDead([pid])).toBe(true);
    await app.stop(); // idempotent
  });

  it("fails fast when the app exits before becoming healthy", async () => {
    const t0 = performance.now();
    await expect(
      startApp({
        command: [process.execPath, "tiny-server.mjs"],
        cwd: FIX,
        env: { CRASH: "1" },
        readyWhen: ready,
        clock: systemClock,
      }),
    ).rejects.toThrow(/exited before becoming healthy.*crashing on purpose/);
    expect(performance.now() - t0).toBeLessThan(8000);
  });

  it("times out and kills the app when never healthy", async () => {
    await expect(
      startApp({
        command: [process.execPath, "tiny-server.mjs"],
        cwd: FIX,
        readyWhen: { path: "/healthz", status: [418], timeoutMs: 800, intervalMs: 50 },
        clock: systemClock,
      }),
    ).rejects.toThrow(/not healthy/);
  });
});
