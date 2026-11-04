import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRelativeSpec, resolvePluginModule } from "../../../src/core/plugins/resolve.js";
import { makePluginProject, type PluginProject } from "./project.js";

let proj: PluginProject;
beforeEach(async () => {
  proj = await makePluginProject();
});
afterEach(async () => {
  await proj.cleanup();
});

describe("plugin resolution (docs/10 §3)", () => {
  it("resolves a scoped ESM package from the project's node_modules via exports (import condition, types skipped)", () => {
    expect(resolvePluginModule("@acme/sw-extras", proj.path)).toBe(
      proj.join("node_modules", "@acme", "sw-extras", "index.mjs"),
    );
  });

  it("resolves a CJS package via main", () => {
    expect(resolvePluginModule("sw-plugin-cjs", proj.path)).toBe(
      proj.join("node_modules", "sw-plugin-cjs", "lib", "main.cjs"),
    );
  });

  it("walks up from a nested config folder like Node", () => {
    const nested = proj.join("apps", "api");
    mkdirSync(nested, { recursive: true });
    expect(resolvePluginModule("@acme/sw-extras", nested)).toBe(
      proj.join("node_modules", "@acme", "sw-extras", "index.mjs"),
    );
  });

  it("resolves relative paths against the project folder (file or directory)", () => {
    expect(resolvePluginModule("./plugins/local-plugin.mjs", proj.path)).toBe(
      proj.join("plugins", "local-plugin.mjs"),
    );
    expect(resolvePluginModule("./plugins/local-plugin", proj.path)).toBe(
      proj.join("plugins", "local-plugin.mjs"),
    );
    expect(resolvePluginModule("./node_modules/sw-plugin-cjs", proj.path)).toBe(
      proj.join("node_modules", "sw-plugin-cjs", "lib", "main.cjs"),
    );
  });

  it("does not resolve from SECOND WORLD's own node_modules (no auto-discovery)", () => {
    // `vitest` is installed in the repo, not in the temp project.
    expect(() => resolvePluginModule("vitest", proj.path)).toThrow(/not installed in the project/);
    try {
      resolvePluginModule("@acme/missing", proj.path);
    } catch (e) {
      expect((e as { code: string }).code).toBe("SW_CONFIG_PLUGIN_NOT_FOUND");
      expect((e as { hint: string }).hint).toBe("Install it in the project: npm i -D @acme/missing");
    }
  });

  it("rejects absolute paths and malformed names", () => {
    expect(() => resolvePluginModule(proj.join("plugins", "local-plugin.mjs"), proj.path)).toThrow(
      /absolute paths are not accepted/,
    );
    expect(() => resolvePluginModule("Not A Package!", proj.path)).toThrow(
      /not a package name or relative path/,
    );
    expect(() => resolvePluginModule("./plugins/nope.mjs", proj.path)).toThrow(/no module at/);
  });

  it("an exports map without a usable condition is reported as not found", () => {
    const dir = proj.join("node_modules", "sw-plugin-types-only");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", exports: { types: "./a.d.ts" } }),
    );
    expect(() => resolvePluginModule("sw-plugin-types-only", proj.path)).toThrow(
      /not installed in the project/,
    );
  });

  it("isRelativeSpec handles both separators", () => {
    expect(isRelativeSpec("./a")).toBe(true);
    expect(isRelativeSpec("..\\a")).toBe(true);
    expect(isRelativeSpec(".x")).toBe(false);
    expect(isRelativeSpec("@acme/x")).toBe(false);
  });
});
