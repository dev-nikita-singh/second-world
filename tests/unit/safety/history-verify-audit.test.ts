/**
 * `sw history verify` also checks the safety audit log's hash chain (docs/11-safety-security-privacy.md
 * §3). A tampered chain exits 1 — the same code as a corrupted history store (an integrity check that
 * failed; docs/16-system-design.md §3 exit table), not 3 (safety refused traffic) or 70 (bug).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import { runCli } from "../../helpers/cli.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };
let dir = "";
let audit = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sw-hv-audit-"));
  writeFileSync(join(dir, "sw.config.json"), "{}\n");
  audit = join(dir, ".second-world", "audit.log");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("sw history verify: audit log", () => {
  it("no audit log yet: reported, exit 0", async () => {
    const r = await runCli(["history", "verify"], { cwd: dir, env });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/audit log: none at .*audit\.log/);
  }, 60_000);

  it("intact chain: exit 0, entry count shown; --json carries the audit result", async () => {
    const g = createSafetyGuard({}, { interactive: false, auditFile: audit });
    g.audit({ action: "target.allowed", target: "http://127.0.0.1:3000" });
    g.audit({ action: "budget.reserved", detail: { maxRps: 50 } });
    g.audit({ action: "budget.released", detail: { taken: 10 } });
    const r = await runCli(["history", "verify"], { cwd: dir, env });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/audit log intact: 3 entries hash-chained/);
    const j = await runCli(["history", "verify", "--json"], { cwd: dir, env });
    expect(j.exitCode).toBe(0);
    expect(JSON.parse(j.stdout)).toMatchObject({
      ok: true,
      history: { ok: true },
      audit: { ok: true, entries: 3 },
    });
  }, 60_000);

  it("torn last line (crash mid-write): exit 0 but printed as a warning, and listed in --json", async () => {
    const before = readFileSync(audit, "utf8");
    writeFileSync(audit, `${before}{"seq":4,"ts":"2026-`);
    const r = await runCli(["history", "verify"], { cwd: dir, env });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/audit log intact: 3 entries hash-chained/);
    expect(r.stdout).toMatch(/line 4 unreadable: a write cut short by a crash/);
    const j = await runCli(["history", "verify", "--json"], { cwd: dir, env });
    expect(JSON.parse(j.stdout)).toMatchObject({ ok: true, audit: { ok: true, entries: 3, torn: [4] } });
    writeFileSync(audit, before);
  }, 60_000);

  it("tampered entry: exit 1 with the broken line", async () => {
    const lines = readFileSync(audit, "utf8").trimEnd().split("\n");
    lines[1] = (lines[1] as string).replace('"maxRps":50', '"maxRps":5000');
    writeFileSync(audit, `${lines.join("\n")}\n`);
    const r = await runCli(["history", "verify"], { cwd: dir, env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/history intact/);
    expect(r.stdout).toMatch(
      /audit log TAMPERED or corrupted: hash chain broken at line 2 \(the entry was modified\)/,
    );
    const j = await runCli(["history", "verify", "--json"], { cwd: dir, env });
    expect(j.exitCode).toBe(1);
    expect(JSON.parse(j.stdout)).toMatchObject({
      ok: false,
      history: { ok: true },
      audit: { ok: false, brokenAt: 2, reason: "hash-mismatch" },
    });
  }, 60_000);

  it("deleted entry: exit 1, reported as removed/reordered", async () => {
    const g = createSafetyGuard({}, { interactive: false, auditFile: audit });
    rmSync(audit);
    for (let i = 0; i < 3; i++) g.audit({ action: `a${i}` });
    const lines = readFileSync(audit, "utf8").trimEnd().split("\n");
    lines.splice(0, 1);
    writeFileSync(audit, `${lines.join("\n")}\n`);
    const r = await runCli(["history", "verify"], { cwd: dir, env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/broken at line 1 \(an earlier entry was removed, reordered or replaced\)/);
  }, 60_000);
});
