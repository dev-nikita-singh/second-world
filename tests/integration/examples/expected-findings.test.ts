/** Ground-truth files are well-formed and their locations match the SEEDED-DEFECT markers. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { EngineIdSchema, CategorySchema, SeveritySchema } from "../../../src/core/evidence/schemas.js";
import { REPO_ROOT } from "../../helpers/cli.js";

const EXTRA_ENGINES = new Set(["evolution"]); // planned engine ids beyond EngineIdSchema today

for (const app of ["shop-express", "shop-fastify"]) {
  describe(`${app}/expected-findings.json`, () => {
    const dir = path.join(REPO_ROOT, "examples", app);
    const doc = JSON.parse(readFileSync(path.join(dir, "expected-findings.json"), "utf8")) as {
      app: string;
      defects: { id: string; engine: string; category: string; severity: string; location: { file: string; line: number } }[];
    };

    it("has unique ids and valid engine/category/severity", () => {
      expect(doc.app).toBe(app);
      const ids = doc.defects.map((d) => d.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const d of doc.defects) {
        expect(EngineIdSchema.safeParse(d.engine).success || EXTRA_ENGINES.has(d.engine), d.id).toBe(true);
        expect(CategorySchema.safeParse(d.category).success, d.id).toBe(true);
        expect(SeveritySchema.safeParse(d.severity).success, d.id).toBe(true);
        expect(existsSync(path.join(dir, d.location.file)), d.location.file).toBe(true);
      }
    });

    it("location.symbol names a function declared in that file and the line lies inside it", () => {
      for (const d of doc.defects as { id: string; location: { file: string; line: number; symbol?: string } }[]) {
        if (!d.location.symbol) continue;
        const lines = readFileSync(path.join(dir, d.location.file), "utf8").split(/\r?\n/);
        const declLine = lines.findIndex((l) => new RegExp(`function ${d.location.symbol}\\b`).test(l)) + 1;
        expect(declLine, `${d.id}: function ${d.location.symbol}`).toBeGreaterThan(0);
        expect(d.location.line, d.id).toBeGreaterThan(declLine);
      }
    });

    it("locations point at the line after each SEEDED-DEFECT marker", async () => {
      const r = await execa(process.execPath, [path.join(REPO_ROOT, "examples", "_tools", "sync-expected-findings.mjs"), dir, "--check"], {
        reject: false,
      });
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
    });
  });
}
