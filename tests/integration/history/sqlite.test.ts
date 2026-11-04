/**
 * SQLite history backend with real processes (docs/03-engines/evidence-and-history.md §B.1):
 * two writers at once lose nothing, a killed writer leaves a readable database, node:sqlite's
 * ExperimentalWarning is not printed (other warnings are), `--no-experimental-sqlite` falls back to
 * JSONL with a warning, and the CLI (`sw history list/show/verify`) works on a sqlite-configured project.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonlStore, openHistoryStore } from "../../../src/engines/history/index.js";
import { REPO_ROOT, runCli } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX = pathToFileURL(path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const WRITER = path.join(HERE, "fixtures", "sqlite-writer.ts");

let tmp: TmpDir;
beforeEach(async () => {
  tmp = await makeTmpDir("sw-sqlite-int-");
});
afterEach(async () => {
  await tmp.cleanup();
});

function writer(dir: string, tag: string, count: number, pad = 0, nodeArgs: string[] = []) {
  return execa(
    process.execPath,
    [...nodeArgs, "--import", TSX, WRITER, dir, tag, String(count), String(pad)],
    {
      reject: false,
      timeout: 120_000,
      stdin: "ignore",
      windowsHide: true,
    },
  );
}

const appendedIds = (stdout: string): string[] =>
  stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith("appended "))
    .map((l) => l.slice(9));

describe("SQLite history: multiple processes", () => {
  it("two processes appending at the same time lose nothing", { timeout: 120_000 }, async () => {
    const dir = tmp.join("history");
    const N = 40;
    const [a, b] = await Promise.all([writer(dir, "alpha", N, 2000), writer(dir, "beta", N, 2000)]);
    expect(a.exitCode, String(a.stderr)).toBe(0);
    expect(b.exitCode, String(b.stderr)).toBe(0);
    const ids = [...appendedIds(String(a.stdout)), ...appendedIds(String(b.stdout))];
    expect(ids.length).toBe(2 * N);
    const store = await openHistoryStore({ dir, backend: "sqlite", captureGit: false });
    const all = await store.list();
    expect(all.length).toBe(2 * N);
    expect(new Set(all.map((e) => e.id))).toEqual(new Set(ids));
    expect((await store.query({ label: "alpha" })).length).toBe(N);
    expect((await store.query({ tag: "beta" })).length).toBe(N);
    expect(await store.verify()).toMatchObject({ ok: true, checked: 2 * N, errors: [] });
  });

  it("a writer killed mid-append leaves a readable, verifiable database", { timeout: 120_000 }, async () => {
    const dir = tmp.join("history");
    for (let round = 0; round < 2; round++) {
      const p = writer(dir, `k${round}`, 0, 400_000);
      let printed = "";
      await new Promise<void>((resolve) => {
        p.stdout?.on("data", (d: Buffer) => {
          printed += d.toString();
          if (appendedIds(printed).length >= 3 + round) resolve();
        });
        void p.then(() => resolve());
      });
      p.kill("SIGKILL");
      await p;
      const committed = appendedIds(printed);
      const store = await openHistoryStore({ dir, backend: "sqlite", captureGit: false });
      const ids = new Set((await store.list({ label: `k${round}` })).map((e) => e.id));
      for (const id of committed) expect(ids.has(id)).toBe(true); // every acknowledged run survived
      const v = await store.verify();
      expect(v.errors).toEqual([]);
      expect(v.ok).toBe(true);
      expect((await store.get(committed[0] as string))?.id).toBe(committed[0]);
    }
  });
});

describe("SQLite history: loading", () => {
  it("node:sqlite's ExperimentalWarning is suppressed; nothing else is", { timeout: 60_000 }, async () => {
    const probe = tmp.join("probe.mts");
    const idx = pathToFileURL(path.join(REPO_ROOT, "src", "engines", "history", "index.ts")).href;
    writeFileSync(
      probe,
      [
        `import { openHistoryStore } from ${JSON.stringify(idx)};`,
        `const s = await openHistoryStore({ dir: ${JSON.stringify(tmp.join("h"))}, backend: "sqlite", captureGit: false });`,
        `console.log("backend", s.backend, (await s.list()).length);`,
        `process.emitWarning("Some other feature is experimental", "ExperimentalWarning");`,
        `process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");`,
        "",
      ].join("\n"),
    );
    const r = await execa(process.execPath, ["--import", TSX, probe], { reject: false, windowsHide: true });
    expect(r.exitCode, String(r.stderr)).toBe(0);
    expect(String(r.stdout)).toMatch(/backend sqlite 0/);
    // the filter is only active while node:sqlite loads: a later identical warning is NOT swallowed
    const stderr = String(r.stderr);
    expect(stderr).toMatch(/Some other feature is experimental/);
    expect(stderr.match(/SQLite is an experimental feature/g)?.length ?? 0).toBe(1);
  });

  it("without node:sqlite (--no-experimental-sqlite) it falls back to JSONL with a warning", {
    timeout: 60_000,
  }, async () => {
    const dir = tmp.join("history");
    const r = await writer(dir, "fb", 2, 0, ["--no-experimental-sqlite"]);
    expect(r.exitCode, String(r.stderr)).toBe(0);
    const out = String(r.stdout);
    expect(out).toMatch(/backend jsonl/);
    expect(out).toMatch(
      /warning: history\.backend "sqlite": node:sqlite is not available .*using the JSONL history/,
    );
    expect(existsSync(path.join(dir, "runs.jsonl"))).toBe(true);
    expect(existsSync(path.join(dir, "history.db"))).toBe(false);
    expect((await createJsonlStore({ dir }).list()).length).toBe(2);
  });
});

describe("SQLite history: CLI on a project configured with history.backend sqlite", () => {
  it("imports the old JSONL history once; list / show / verify (with audit chain) work", {
    timeout: 120_000,
  }, async () => {
    const env = { SW_USER_CONFIG_DIR: tmp.join("no-user-config") };
    const hist = path.join(tmp.path, ".second-world", "history");
    const old = createJsonlStore({ dir: hist, captureGit: false });
    const e = await old.append({
      results: [
        {
          schemaVersion: 1,
          engine: "performance",
          runId: "old-1",
          status: "passed",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
          findings: [],
          limitations: [],
          artifacts: [],
          data: { latency: { corrected: { p95: 42 } }, totals: { rps: 1, errorRate: 0, requests: 1 } },
        } as never,
      ],
      label: "before-switch",
    });
    writeFileSync(tmp.join("sw.config.json"), `${JSON.stringify({ history: { backend: "sqlite" } })}\n`);
    const list = await runCli(["history", "list", "--json"], { cwd: tmp.path, env });
    expect(list.exitCode, list.stderr).toBe(0);
    expect((JSON.parse(list.stdout) as { id: string }[]).map((x) => x.id)).toEqual([e.id]);
    expect(list.stderr).toMatch(/imported 1 run\(s\) from the JSONL history/);
    expect(list.stderr).not.toMatch(/ExperimentalWarning|SQLite is an experimental/);
    expect(existsSync(path.join(hist, "history.db"))).toBe(true);
    const show = await runCli(["history", "show", e.id.slice(0, 10)], { cwd: tmp.path, env });
    expect(show.exitCode, show.stderr).toBe(0);
    expect(show.stdout).toMatch(/before-switch/);
    const again = await runCli(["history", "list"], { cwd: tmp.path, env });
    expect(again.stderr).not.toMatch(/imported/);
    const v = await runCli(["history", "verify", "--json"], { cwd: tmp.path, env });
    expect(v.exitCode, v.stderr).toBe(0);
    expect(JSON.parse(v.stdout)).toMatchObject({
      ok: true,
      checked: 1,
      backend: "sqlite",
      history: { ok: true },
    });
    expect(JSON.parse(v.stdout).audit).toBeDefined();
  });
});
