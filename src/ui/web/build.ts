/**
 * Builds the `sw ui` browser app into `outDir`: index.html, app.js (one minified ES module, Preact bundled
 * in), app.css, favicon.svg. Used by `npm run build` (→ dist/ui) and, when SECOND WORLD runs from source,
 * by src/ui/server/assets.ts on `sw ui` start. Node-only (not part of the browser bundle).
 *
 *   npx tsx src/ui/web/build.ts dist/ui
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const STATIC_FILES = ["index.html", "app.css", "favicon.svg"] as const;

export async function buildUiAssets(outDir: string): Promise<void> {
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const { build } = await import("rolldown");
  await build({
    input: join(here, "main.tsx"),
    platform: "browser",
    tsconfig: join(here, "tsconfig.json"),
    logLevel: "warn",
    output: {
      file: join(out, "app.js"),
      format: "esm",
      minify: true,
      sourcemap: false,
      codeSplitting: false,
    },
  });
  for (const f of STATIC_FILES) copyFileSync(join(here, f), join(out, f));
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? "dist/ui";
  buildUiAssets(target).then(
    () => process.stdout.write(`UI built into ${target}\n`),
    (e: unknown) => {
      process.stderr.write(`UI build failed: ${String(e)}\n`);
      process.exit(1);
    },
  );
}
