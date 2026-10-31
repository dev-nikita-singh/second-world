/**
 * Public API freeze (docs/09-cli-and-api.md §3 stability policy, docs/16-system-design.md §11).
 * The exported names of src/index.ts and their kinds are compared to a committed snapshot, so an
 * accidental addition, removal or kind change (e.g. class -> function) fails CI.
 *
 * Intentional API change: run `npx vitest run tests/unit/design/public-api.test.ts -u`, review the
 * diff of __snapshots__/public-api.txt, and mention it in CHANGELOG.md.
 */
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as api from "../../../src/index.js";

const ENTRY = resolve(import.meta.dirname, "../../../src/index.ts");

function kindOf(sym: ts.Symbol, checker: ts.TypeChecker): string {
  const s = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  const f = s.flags;
  const kinds: string[] = [];
  if (f & ts.SymbolFlags.Class) kinds.push("class");
  else if (f & ts.SymbolFlags.Function) kinds.push("function");
  else if (f & ts.SymbolFlags.Enum) kinds.push("enum");
  else if (f & ts.SymbolFlags.Variable) {
    const decl = s.valueDeclaration;
    const isConst =
      decl !== undefined &&
      ts.isVariableDeclaration(decl) &&
      (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
    kinds.push(isConst ? "const" : "let");
  }
  if (f & ts.SymbolFlags.Interface) kinds.push("interface");
  if (f & ts.SymbolFlags.TypeAlias) kinds.push("type");
  if (kinds.length === 0) kinds.push(`flags:${f}`);
  return kinds.join("+");
}

function publicApi(): string[] {
  const program = ts.createProgram([ENTRY], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    types: ["node"],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(ENTRY);
  if (sf === undefined) throw new Error("src/index.ts not found by the TypeScript program");
  const mod = checker.getSymbolAtLocation(sf);
  if (mod === undefined) throw new Error("src/index.ts has no module symbol");
  return checker
    .getExportsOfModule(mod)
    .map((s) => `${s.getName()}: ${kindOf(s, checker)}`)
    .sort();
}

describe("public API of src/index.ts", () => {
  const lines = publicApi();

  it("matches the committed snapshot (names + kinds)", async () => {
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("./__snapshots__/public-api.txt");
  });

  it("every runtime export in the snapshot exists at runtime (and vice versa)", () => {
    const runtimeKinds = /: (class|function|enum|const|let)/;
    const declared = lines
      .filter((l) => runtimeKinds.test(l))
      .map((l) => l.slice(0, l.indexOf(":")))
      .sort();
    expect(Object.keys(api).sort()).toEqual(declared);
  });

  it("contains the documented entry points (docs/09 §2)", () => {
    for (const name of ["createWorld", "defineConfig", "loadConfig", "ExitCode", "SecondWorldError"]) {
      expect(lines.some((l) => l.startsWith(`${name}:`))).toBe(true);
    }
  });
});
