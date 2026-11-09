/**
 * Static files of the browser app. Published package: prebuilt in `dist/ui/` (npm run build). From source
 * (tsx, development): built once per `sw ui` start into `node_modules/.cache/second-world-ui` with the
 * bundler in src/ui/web/build.ts. Only the files found in that folder at start-up are served (an allow-list:
 * no path from a request ever reaches the file system).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Assets {
  dir: string;
  files: Map<string, { body: Buffer; type: string }>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export function loadAssets(dir: string): Assets {
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const name of readdirSync(dir)) {
    const type = TYPES[extname(name)];
    if (!type || !/^[A-Za-z0-9._-]+$/.test(name)) continue;
    files.set(name, { body: readFileSync(join(dir, name)), type });
  }
  if (!files.has("index.html")) throw new Error(`UI assets in ${dir} have no index.html`);
  return { dir, files };
}

/** Finds (or, from source, builds) the asset folder. */
export async function resolveAssets(): Promise<Assets> {
  const override = process.env.SECOND_WORLD_UI_ASSETS;
  if (override) return loadAssets(resolve(override));
  const here = dirname(fileURLToPath(import.meta.url));
  const fromSource = import.meta.url.endsWith(".ts");
  if (!fromSource) {
    // Bundled: this code lives in dist/*.mjs|cjs, the assets in dist/ui/.
    for (const dir of [join(here, "ui"), join(here, "..", "ui")]) {
      if (existsSync(join(dir, "index.html"))) return loadAssets(dir);
    }
    throw new Error("UI assets are missing from this installation (dist/ui). Reinstall second-world.");
  }
  // src/ui/server → repo root
  const root = resolve(here, "..", "..", "..");
  const out = join(root, "node_modules", ".cache", "second-world-ui");
  // A non-literal specifier keeps the bundler (a devDependency) out of the published build.
  const builder = "../web/build.ts";
  const { buildUiAssets } = (await import(builder)) as { buildUiAssets(outDir: string): Promise<void> };
  await buildUiAssets(out);
  return loadAssets(out);
}
