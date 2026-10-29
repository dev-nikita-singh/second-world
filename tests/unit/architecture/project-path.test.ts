/**
 * A project path that does not exist (or is a file) is a usage error: ConfigError (exit 2), not a run
 * that "passes" with an ARCH_NO_FILES limitation. An existing directory without sources stays a
 * limitation (docs/03-engines/architecture-inspector.md §Limitations).
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import { inspectArchitecture } from "../../../src/engines/architecture/index.js";
import { makeTmpDir } from "../../helpers/tmp.js";

describe("architecture project path", () => {
  it("a missing path → ConfigError SW_CONFIG_PROJECT naming the path", async () => {
    const dir = await makeTmpDir("sw-arch-missing-");
    try {
      const missing = path.join(dir.path, "does", "not", "exist");
      const p = inspectArchitecture({ project: missing, noCache: true });
      await expect(p).rejects.toBeInstanceOf(ConfigError);
      await expect(inspectArchitecture({ project: missing, noCache: true })).rejects.toMatchObject({
        code: "SW_CONFIG_PROJECT",
        message: expect.stringContaining(missing),
      });
    } finally {
      await dir.cleanup();
    }
  });

  it("a file instead of a directory → ConfigError", async () => {
    const dir = await makeTmpDir("sw-arch-file-");
    try {
      const file = path.join(dir.path, "a.ts");
      await writeFile(file, "export const a = 1;\n");
      await expect(inspectArchitecture({ project: file, noCache: true })).rejects.toMatchObject({
        code: "SW_CONFIG_PROJECT",
      });
    } finally {
      await dir.cleanup();
    }
  });
});
