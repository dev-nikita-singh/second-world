/**
 * Temp project with fixture plugins installed in its node_modules (tests/fixtures/plugins).
 */
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/plugins");

export interface PluginProject extends TmpDir {
  writeConfig(config: Record<string, unknown>): string;
}

export async function makePluginProject(
  opts: { install?: ("acme" | "cjs")[]; local?: boolean } = {},
): Promise<PluginProject> {
  const tmp = await makeTmpDir("sw-plugins-");
  for (const which of opts.install ?? ["acme", "cjs"]) {
    const [src, dest] =
      which === "acme"
        ? ["acme-extras", path.join("node_modules", "@acme", "sw-extras")]
        : ["sw-plugin-cjs", path.join("node_modules", "sw-plugin-cjs")];
    cpSync(path.join(FIXTURES, src), tmp.join(dest), { recursive: true });
  }
  if (opts.local !== false) {
    mkdirSync(tmp.join("plugins"), { recursive: true });
    cpSync(path.join(FIXTURES, "local-plugin.mjs"), tmp.join("plugins", "local-plugin.mjs"));
    cpSync(path.join(FIXTURES, "broken-plugins.mjs"), tmp.join("plugins", "broken-plugins.mjs"));
  }
  writeFileSync(tmp.join("package.json"), JSON.stringify({ name: "proj", private: true }));
  return {
    ...tmp,
    writeConfig(config) {
      const file = tmp.join("sw.config.json");
      writeFileSync(file, JSON.stringify(config, null, 2));
      return file;
    },
  };
}
