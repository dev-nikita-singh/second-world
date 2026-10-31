/**
 * Real concurrent `sw` processes on one project (Plan wave 7 §A): history JSONL + index, report dir,
 * and crash consistency when a history writer process is killed mid-write.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHistoryStore } from "../../../src/engines/history/index.js";
import { type CalibratedServer, startCalibratedServer } from "../../fixtures/servers/calibrated.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";
import { HISTORY_WRITER, LEFTOVER, sw, TSX_LOADER, walk } from "./helpers.js";

let srv: CalibratedServer;
let userCfg: TmpDir;
let tmp: TmpDir;

beforeAll(async () => {
  srv = await startCalibratedServer({ precise: false });
  userCfg = await makeTmpDir("sw-conc-ucfg-");
});
afterAll(async () => {
  await srv?.close();
  await userCfg?.cleanup();
});
beforeEach(async () => {
  tmp = await makeTmpDir("sw-conc-cli-");
});
afterEach(async () => {
  await tmp.cleanup();
});

const env = (): Record<string, string> => ({ SW_USER_CONFIG_DIR: userCfg.path });

describe("4 parallel `sw perf` runs in one project", () => {
  it("every run lands in history once, the index is clean, report files are complete, nothing left behind", async () => {
    const N = 4;
    const runs = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        sw(
          [
            "perf",
            `${srv.url}/fixed/1`,
            "--rate",
            "20",
            "--duration",
            "1s",
            "--warmup",
            "0s",
            "-f",
            "json,md,junit",
            "-o",
            "out",
            "--label",
            `p${i}`,
          ],
          { cwd: tmp.path, env: env() },
        ),
      ),
    );
    const ids: string[] = [];
    for (const r of runs) {
      expect(r.exitCode, r.stderr.slice(-1500)).toBe(0);
      expect(r.mainReturned && !r.timedOut).toBe(true); // exited on its own
      const m = /history: saved run (\S+)/.exec(r.stderr);
      expect(m, r.stderr.slice(-1500)).not.toBeNull();
      ids.push((m as RegExpExecArray)[1] as string);
    }
    expect(new Set(ids).size).toBe(N);

    const histDir = tmp.join(".second-world", "history");
    const lines = readFileSync(path.join(histDir, "runs.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(N);
    const entries = lines.map((l) => JSON.parse(l) as { id: string; label: string });
    expect(entries.map((e) => e.id).sort()).toEqual([...ids].sort());
    expect(entries.map((e) => e.label).sort()).toEqual(["p0", "p1", "p2", "p3"]);

    const verify = await sw(["history", "verify"], { cwd: tmp.path, env: env() });
    expect(verify.exitCode, verify.stdout + verify.stderr).toBe(0);

    // Same report dir: last writer wins per file, but each file is a complete document of one run.
    const rep = JSON.parse(readFileSync(tmp.join("out", "report.json"), "utf8"));
    expect(ids).toContain(rep.results[0].runId);
    expect(readFileSync(tmp.join("out", "report.junit.xml"), "utf8").trimEnd()).toMatch(/<\/testsuites>$/);
    expect(readFileSync(tmp.join("out", "report.md"), "utf8")).toContain("## SECOND WORLD");

    const files = walk(tmp.path);
    expect(files.filter((f) => LEFTOVER.test(f))).toEqual([]);
  }, 120_000);
});

describe("history writer killed mid-write", () => {
  it("later reads and writes recover: no torn indexed run, stale lock broken, temp files reported then pruned", async () => {
    const dir = tmp.join("h");
    const printed: string[] = [];
    const kidLog: { round: number; seen: number; err: string }[] = [];
    for (let round = 0; round < 3; round++) {
      // two writer processes racing; kill both at an arbitrary point
      const kids = ["a", "b"].map((tag) =>
        execa(process.execPath, ["--import", TSX_LOADER, HISTORY_WRITER, dir, `${tag}${round}`], {
          reject: false,
          windowsHide: true,
          buffer: true,
        }),
      );
      let seen = 0;
      await new Promise<void>((resolve) => {
        for (const k of kids)
          k.stdout?.on("data", (d: Buffer) => {
            for (const m of String(d).matchAll(/appended (\S+)/g)) printed.push(m[1] as string);
            seen += String(d).split("appended").length - 1;
            if (seen >= 3 + round * 2) resolve();
          });
        setTimeout(resolve, 30_000);
      });
      // land the kill at an arbitrary point inside the next append (deterministic spread per round)
      await new Promise((r) => setTimeout(r, [3, 11, 23][round]));
      for (const k of kids) k.kill("SIGKILL");
      const done = await Promise.all(kids);
      kidLog.push(...done.map((d) => ({ round, seen, err: String(d.stderr).slice(-800) })));
    }
    // writers only ever die by our kill: none gave up on a lock left by a killed predecessor
    expect(kidLog.filter((k) => k.err !== "" || k.seen === 0)).toEqual([]);
    const warnings: string[] = [];
    const store = createHistoryStore({
      dir,
      captureGit: false,
      onWarning: (m) => warnings.push(m),
      lock: { timeoutMs: 5000 },
    });
    const before = await store.list();
    // every append a writer reported as done survived the kill (no lost committed record)
    expect(printed.length).toBeGreaterThanOrEqual(15);
    expect(printed.filter((id) => !before.some((b) => b.id === id))).toEqual([]);
    const v1 = await store.verify();
    // a killed writer may leave: a torn last index line, a temp body, an orphan body — never a
    // broken indexed run (the body is renamed into place before its index line is appended)
    const bad = v1.errors.filter((e) => e.problem !== "corrupt-index-line");
    expect(bad).toEqual([]);
    for (const w of v1.warnings) expect(["leftover-temp", "orphan-report"]).toContain(w.problem);
    for (const e of before) expect(await store.get(e.id)).not.toBeNull();

    // a lock left by a killed holder (dead pid) must not block the next writer
    const after = await store.append({
      results: [{ ...(await store.get(before[0]!.id))!.results[0]!, runId: "after" }],
    });
    expect((await store.list())[0]!.id).toBe(after.id);
    await store.prune({ keepLast: 10_000 });
    const v2 = await store.verify();
    expect(v2.warnings.filter((w) => w.problem === "leftover-temp")).toEqual([]);
    expect(walk(dir).filter((f) => LEFTOVER.test(f))).toEqual([]);
  }, 120_000);
});
