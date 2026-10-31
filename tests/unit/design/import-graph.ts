/**
 * Static import graph of src/ for the architecture enforcement tests (docs/02-architecture.md §2,
 * docs/16-system-design.md §1). Parses every .ts file with the TypeScript compiler API (dev
 * dependency) — no regexes — and records each relative import with its kind:
 *   - "value":   `import { x } from "./y.js"` / `export { x } from` / side-effect `import "./y.js"`
 *   - "type":    `import type …` / `export type … from` / every specifier marked `type`
 *   - "dynamic": `import("./y.js")` (lazy load; never part of module initialisation order)
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

export type ImportKind = "value" | "type" | "dynamic";

export interface ImportEdge {
  /** importer, relative to src/ with forward slashes, e.g. "core/world.ts" */
  from: string;
  /** imported file, relative to src/, e.g. "engines/history/index.ts" */
  to: string;
  kind: ImportKind;
  /** 1-based line of the import in `from` */
  line: number;
}

export const SRC_DIR = resolve(import.meta.dirname, "../../../src");

export function listSourceFiles(dir = SRC_DIR): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop() as string;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
    }
  }
  return out.sort();
}

const rel = (abs: string): string => relative(SRC_DIR, abs).split(sep).join("/");

function resolveSpec(fromAbs: string, spec: string): string {
  const target = resolve(dirname(fromAbs), spec);
  return rel(target.replace(/\.(m?)js$/, ".$1ts"));
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false; // side-effect import
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false; // default import is a value
  const nb = clause.namedBindings;
  if (nb === undefined) return false;
  if (ts.isNamespaceImport(nb)) return false;
  return nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const ec = node.exportClause;
  if (ec === undefined || !ts.isNamedExports(ec)) return false;
  return ec.elements.length > 0 && ec.elements.every((e) => e.isTypeOnly);
}

export function parseImports(fileAbs: string): ImportEdge[] {
  const text = readFileSync(fileAbs, "utf8");
  const sf = ts.createSourceFile(fileAbs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const from = rel(fileAbs);
  const edges: ImportEdge[] = [];
  const add = (spec: string, kind: ImportKind, node: ts.Node): void => {
    if (!spec.startsWith(".")) return; // packages and node: built-ins are not layers
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    edges.push({ from, to: resolveSpec(fileAbs, spec), kind, line });
  };
  // Iterative walk (no recursion on user-sized input, house rule).
  const stack: ts.Node[] = [sf];
  while (stack.length > 0) {
    const node = stack.pop() as ts.Node;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, isTypeOnlyImport(node) ? "type" : "value", node);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, isTypeOnlyExport(node) ? "type" : "value", node);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0] as ts.Node)
    ) {
      add((node.arguments[0] as ts.StringLiteralLike).text, "dynamic", node);
    } else if (ts.isImportTypeNode(node)) {
      // `typeof import("./x.js")` in a type position
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) add(arg.literal.text, "type", node);
    }
    node.forEachChild((c) => {
      stack.push(c);
    });
  }
  return edges;
}

/** Layer of a src-relative path: "core", "shared", "adapters", "cli", "index", "types" or "engines/<name>". */
export function layerOf(path: string): string {
  const parts = path.split("/");
  const top = parts[0] ?? "";
  if (top === "engines") return `engines/${parts[1] ?? ""}`;
  if (top.endsWith(".ts")) return top.slice(0, -3);
  return top;
}

export function buildImportGraph(): ImportEdge[] {
  return listSourceFiles().flatMap(parseImports);
}

/**
 * Strongly connected components with more than one node (or a self-loop) over the given edges.
 * Iterative Tarjan.
 */
export function findCycles(edges: readonly ImportEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    (adj.get(e.from) as string[]).push(e.to);
  }
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const st: string[] = [];
  const out: string[][] = [];
  for (const root of [...adj.keys()].sort()) {
    if (idx.has(root)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: root, i: 0 }];
    idx.set(root, index);
    low.set(root, index);
    index++;
    st.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const top = work[work.length - 1] as { v: string; i: number };
      const succ = adj.get(top.v) as string[];
      if (top.i < succ.length) {
        const w = succ[top.i++] as string;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          st.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v) as number, idx.get(w) as number));
        }
      } else {
        work.pop();
        const parent = work[work.length - 1];
        if (parent !== undefined)
          low.set(parent.v, Math.min(low.get(parent.v) as number, low.get(top.v) as number));
        if (low.get(top.v) === idx.get(top.v)) {
          const comp: string[] = [];
          for (;;) {
            const w = st.pop() as string;
            onStack.delete(w);
            comp.push(w);
            if (w === top.v) break;
          }
          const selfLoop = comp.length === 1 && succ.includes(top.v);
          if (comp.length > 1 || selfLoop) out.push(comp.sort());
        }
      }
    }
  }
  return out;
}
