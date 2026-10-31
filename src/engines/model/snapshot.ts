/**
 * Model snapshots on disk (canonical JSON) — docs/03-engines/system-model.md §3 ("models are versioned"),
 * docs/03-engines/evidence-and-history.md (architecture snapshots). Default dir: <cwd>/.second-world/model.
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../../shared/util/atomic-write.js";
import { sha256 } from "../../shared/util/hash.js";
import { toCanonicalJson } from "./export.js";
import { withGraph } from "./graph.js";
import { MODEL_SCHEMA_VERSION, type ModelData } from "./types.js";

export async function saveModelSnapshot(
  model: ModelData,
  opts: { dir?: string; cwd?: string; name?: string } = {},
): Promise<{ path: string; latest: string; hash: string }> {
  const dir = opts.dir ?? path.join(opts.cwd ?? process.cwd(), ".second-world", "model");
  await mkdir(dir, { recursive: true });
  const text = toCanonicalJson(model);
  const hash = sha256(text).slice(0, 12);
  const stamp = model.builtAt.replace(/[:.]/g, "-");
  const file = path.join(dir, `${opts.name ?? `model-${stamp}-${hash}`}.json`);
  const latest = path.join(dir, "latest.json");
  // Unique temp names + rename retry: concurrent saves (same process or not) never collide.
  for (const target of [file, latest]) await writeFileAtomic(target, text);
  return { path: file, latest, hash };
}

export async function loadModelSnapshot(
  file: string,
): Promise<ModelData & { readonly graph: import("./graph.js").ModelGraph }> {
  const data = JSON.parse(await readFile(file, "utf8")) as ModelData;
  if (data?.schemaVersion !== MODEL_SCHEMA_VERSION)
    throw new Error(
      `${file}: unsupported model schemaVersion ${String(data?.schemaVersion)} (expected ${MODEL_SCHEMA_VERSION})`,
    );
  return withGraph(data);
}
