/**
 * A tampered history index must not point reads outside the history directory (residual risk from
 * sw-sec-w8, wave 8): index entries are only trusted when `file` is `runs/<id>.json.gz`, and run ids
 * that could build another path are rejected when saving.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonlStore, isIndexEntry } from "../../../src/engines/history/jsonl-store.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir | undefined;
afterEach(async () => {
  await tmp?.cleanup();
  tmp = undefined;
});

const entry = (file: string) => ({
  id: "evil",
  file,
  createdAt: "2026-01-01T00:00:00.000Z",
  tags: [],
  engines: ["performance"],
  status: "passed",
  metrics: {},
  findings: { count: 0, fingerprints: [], maxSeverity: null },
});

describe("history index paths", () => {
  it("only runs/<id>.json.gz is a valid index entry", () => {
    expect(isIndexEntry(entry("runs/01ABC.json.gz"))).toBe(true);
    for (const f of [
      "../secret.json.gz",
      "runs/../../secret.json.gz",
      "/etc/passwd",
      String.raw`C:\x.json.gz`,
      String.raw`runs\..\x.json.gz`,
      "runs/a/b.json.gz",
    ])
      expect(isIndexEntry(entry(f)), f).toBe(false);
  });

  it("a tampered entry pointing outside is skipped, not read", async () => {
    tmp = await makeTmpDir("sw-hist-path-");
    const dir = tmp.join("history");
    await mkdir(dir, { recursive: true });
    // A readable gzip "run" outside the history dir that the tampered entry points at.
    await writeFile(
      tmp.join("outside.json.gz"),
      gzipSync(JSON.stringify({ schemaVersion: 1, id: "evil", results: [] })),
    );
    const warnings: string[] = [];
    const store = createJsonlStore({ dir, onWarning: (m) => warnings.push(m) });
    await appendFile(tmp.join("history", "runs.jsonl"), `${JSON.stringify(entry("../outside.json.gz"))}\n`);
    expect((await store.list()).map((r) => r.id)).not.toContain("evil");
    expect(await store.get("evil")).toBeNull();
    expect(warnings.join("\n")).toMatch(/skipped 1 unreadable line/);
  });

  it("run ids that would build another path are rejected on save", async () => {
    tmp = await makeTmpDir("sw-hist-id-");
    const store = createJsonlStore({ dir: tmp.join("history"), captureGit: false });
    for (const id of ["../x", "a/b", String.raw`a\b`, ".hidden"])
      await expect(store.append({ id, results: [] } as never), id).rejects.toThrow(/Invalid run id/);
  });
});
