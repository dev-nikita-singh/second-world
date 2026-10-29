/** Test helpers: write a small in-temp-dir project and inspect it (no cache, no shared state). */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEngineContext } from "../../../src/core/context.js";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import {
  type ArchitectureData,
  type ArchitectureDeps,
  type ArchitectureInputLoose,
  inspectArchitecture,
} from "../../../src/engines/architecture/index.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

export async function writeProject(files: Record<string, string>, dir?: TmpDir): Promise<TmpDir> {
  const d = dir ?? (await makeTmpDir("sw-arch-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(d.path, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return d;
}

export async function inspectFiles(
  files: Record<string, string>,
  input: Omit<ArchitectureInputLoose, "project"> = {},
  deps: ArchitectureDeps = {},
): Promise<{ result: EngineResult<ArchitectureData>; data: ArchitectureData; dir: TmpDir }> {
  const dir = await writeProject(files);
  try {
    const result = await inspectArchitecture(
      { noCache: true, ...input, project: dir.path },
      createEngineContext(),
      deps,
    );
    if (!result.data) throw new Error(`no data: ${result.status}`);
    return { result, data: result.data, dir };
  } finally {
    await dir.cleanup();
  }
}

export function byRule(r: EngineResult<ArchitectureData>, ruleId: string) {
  return r.findings.filter((f) => f.ruleId === ruleId);
}
