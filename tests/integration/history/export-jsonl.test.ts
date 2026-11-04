/**
 * `sw history export --to jsonl` (wave 9): going back from `history.backend: "sqlite"` to JSONL.
 * Runs written only to SQLite are copied into runs.jsonl (report bytes unchanged, so `verify` passes on the
 * JSONL side), baselines come along, and a second export adds nothing.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHistoryStore } from "../../../src/engines/history/index.js";
import { runCli } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir;
beforeEach(async () => {
  tmp = await makeTmpDir("sw-hist-export-");
});
afterEach(async () => {
  await tmp.cleanup();
});

function result(runId: string, p95: number) {
  return {
    schemaVersion: 1,
    engine: "performance",
    runId,
    status: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    findings: [],
    limitations: [],
    artifacts: [],
    data: { latency: { corrected: { p95 } }, totals: { rps: 1, errorRate: 0, requests: 1 } },
  } as never;
}

describe("sw history export --to jsonl", () => {
  it("copies SQLite-only runs and baselines to JSONL; JSONL list/verify see them; idempotent", {
    timeout: 120_000,
  }, async () => {
    const env = { SW_USER_CONFIG_DIR: tmp.join("no-user-config") };
    const hist = path.join(tmp.path, ".second-world", "history");
    const sqlite = await openHistoryStore({ dir: hist, backend: "sqlite", captureGit: false });
    expect(sqlite.backend).toBe("sqlite");
    const a = await sqlite.append({ results: [result("r-1", 10)], label: "one" });
    const b = await sqlite.append({ results: [result("r-2", 20)], label: "two" });
    await sqlite.setBaseline("main", a.id);
    await sqlite.close?.();
    expect(existsSync(path.join(hist, "runs.jsonl"))).toBe(false);

    writeFileSync(tmp.join("sw.config.json"), `${JSON.stringify({ history: { backend: "sqlite" } })}\n`);
    const dry = await runCli(["history", "export", "--dry-run"], { cwd: tmp.path, env });
    expect(dry.exitCode, dry.stderr).toBe(0);
    expect(existsSync(path.join(hist, "runs.jsonl"))).toBe(false);

    const ex = await runCli(["history", "export", "--to", "jsonl", "--json"], { cwd: tmp.path, env });
    expect(ex.exitCode, ex.stderr).toBe(0);
    expect(JSON.parse(ex.stdout)).toMatchObject({ exported: 2, baselines: 1 });

    const again = await runCli(["history", "export", "--json"], { cwd: tmp.path, env });
    expect(JSON.parse(again.stdout)).toMatchObject({ exported: 0, baselines: 0 });

    writeFileSync(tmp.join("sw.config.json"), `${JSON.stringify({ history: { backend: "jsonl" } })}\n`);
    const list = await runCli(["history", "list", "--json"], { cwd: tmp.path, env });
    expect(list.exitCode, list.stderr).toBe(0);
    expect(new Set((JSON.parse(list.stdout) as { id: string }[]).map((x) => x.id))).toEqual(new Set([a.id, b.id]));
    const show = await runCli(["history", "show", "baseline:main"], { cwd: tmp.path, env });
    expect(show.exitCode, show.stderr).toBe(0);
    const v = await runCli(["history", "verify", "--json"], { cwd: tmp.path, env });
    expect(v.exitCode, v.stdout).toBe(0);
    expect(JSON.parse(v.stdout)).toMatchObject({ ok: true, checked: 2 });
  });

  it("no history.db: exit 2 with a hint; --to other than jsonl: exit 2", { timeout: 60_000 }, async () => {
    const env = { SW_USER_CONFIG_DIR: tmp.join("no-user-config") };
    const none = await runCli(["history", "export"], { cwd: tmp.path, env });
    expect(none.exitCode).toBe(2);
    expect(none.stderr).toMatch(/no SQLite history/);
    const bad = await runCli(["history", "export", "--to", "csv"], { cwd: tmp.path, env });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toMatch(/only "jsonl"/);
  });
});
