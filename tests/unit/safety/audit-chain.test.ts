/**
 * Audit-log hash chain (docs/11-safety-security-privacy.md §3): every entry carries the hash of the
 * previous entry in the FILE, so editing, deleting or reordering lines is detectable by
 * verifyAuditLog / `sw history verify`. Several guards (parallel `sw` processes in one project) share
 * one file and must still produce one valid chain.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { createSafetyGuard, verifyAuditLog } from "../../../src/core/safety/guard.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir | undefined;
afterEach(async () => {
  await tmp?.cleanup();
  tmp = undefined;
});

async function auditFile(): Promise<string> {
  tmp = await makeTmpDir("sw-audit-");
  return path.join(tmp.path, ".second-world", "audit.log");
}

function lines(file: string): string[] {
  return readFileSync(file, "utf8").trimEnd().split("\n");
}

describe("audit chain", () => {
  it("one guard: a valid chain of all entries", async () => {
    const file = await auditFile();
    const g = createSafetyGuard({}, { interactive: false, auditFile: file });
    for (let i = 0; i < 5; i++) g.audit({ action: `a${i}` });
    expect(verifyAuditLog(file)).toEqual({ ok: true, entries: 5 });
  });

  it("two guards on one file (parallel runs) interleave into ONE valid chain", async () => {
    const file = await auditFile();
    const a = createSafetyGuard({}, { interactive: false, auditFile: file });
    const b = createSafetyGuard({}, { interactive: false, auditFile: file });
    for (let i = 0; i < 4; i++) {
      a.audit({ action: `a${i}` });
      b.audit({ action: `b${i}` });
    }
    expect(verifyAuditLog(file)).toEqual({ ok: true, entries: 8 });
    const seqs = lines(file).map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("an edited entry is detected at its line", async () => {
    const file = await auditFile();
    const g = createSafetyGuard({}, { interactive: false, auditFile: file });
    g.audit({ action: "target.allowed", target: "http://127.0.0.1:1" });
    g.audit({ action: "budget.reserved", detail: { maxRps: 10 } });
    g.audit({ action: "budget.released" });
    const ls = lines(file);
    ls[1] = (ls[1] as string).replace('"maxRps":10', '"maxRps":10000');
    writeFileSync(file, `${ls.join("\n")}\n`);
    expect(verifyAuditLog(file)).toMatchObject({
      ok: false,
      entries: 3,
      brokenAt: 2,
      reason: "hash-mismatch",
    });
  });

  it("a deleted middle entry breaks the chain at the next line", async () => {
    const file = await auditFile();
    const g = createSafetyGuard({}, { interactive: false, auditFile: file });
    for (let i = 0; i < 4; i++) g.audit({ action: `a${i}` });
    const ls = lines(file);
    ls.splice(1, 1);
    writeFileSync(file, `${ls.join("\n")}\n`);
    expect(verifyAuditLog(file)).toMatchObject({ ok: false, brokenAt: 2, reason: "prev-hash-mismatch" });
  });

  it("a torn final write (crash mid-append) is a warning, and the next run continues the chain", async () => {
    const file = await auditFile();
    const g = createSafetyGuard({}, { interactive: false, auditFile: file });
    g.audit({ action: "a0" });
    g.audit({ action: "a1" });
    appendFileSync(file, '{"seq":3,"ts":"2026-');
    expect(verifyAuditLog(file)).toMatchObject({ ok: true, entries: 2, torn: [3] });
    const g2 = createSafetyGuard({}, { interactive: false, auditFile: file });
    g2.audit({ action: "after-crash" });
    const v = verifyAuditLog(file);
    expect(v).toMatchObject({ ok: true, entries: 3, torn: [3] });
    expect(JSON.parse(lines(file).at(-1) as string)).toMatchObject({ seq: 3, action: "after-crash" });
  });

  it("garbage replacing a middle entry is still tampering (the next entry chains to the hidden one)", async () => {
    const file = await auditFile();
    const g = createSafetyGuard({}, { interactive: false, auditFile: file });
    for (let i = 0; i < 3; i++) g.audit({ action: `a${i}` });
    const ls = lines(file);
    ls[1] = "garbage";
    writeFileSync(file, `${ls.join("\n")}\n`);
    expect(verifyAuditLog(file)).toMatchObject({ ok: false, brokenAt: 3, reason: "prev-hash-mismatch" });
  });

  it("4 processes appending concurrently to one file produce one valid chain", async () => {
    const file = await auditFile();
    const tsx = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;
    const writer = path.join(import.meta.dirname, "fixtures", "audit-writer.ts");
    await Promise.all(
      [0, 1, 2, 3].map((k) => execa(process.execPath, ["--import", tsx, writer, file, "50", `w${k}`])),
    );
    expect(verifyAuditLog(file)).toEqual({ ok: true, entries: 200 });
    const seqs = lines(file).map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  }, 60_000);

  it("verifies entries larger than the 64 KiB read chunk, with multi-byte text across the boundary", async () => {
    const file = await auditFile();
    const g = createSafetyGuard({}, { interactive: false, auditFile: file });
    g.audit({ action: "big", detail: { note: "é€".repeat(30_000) } });
    g.audit({ action: "after" });
    expect(verifyAuditLog(file)).toEqual({ ok: true, entries: 2 });
  });

  it("a missing or empty file is an empty, valid chain", async () => {
    const file = await auditFile();
    expect(verifyAuditLog(file)).toEqual({ ok: true, entries: 0 });
  });
});
