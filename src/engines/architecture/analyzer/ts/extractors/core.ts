/**
 * Core extractors: module imports (static, re-exports, dynamic import(), require) → module dependency
 * edges, and call resolution (TypeChecker, lazily per call) → unit `calls` edges.
 */
import type * as ts from "typescript";
import type { TsFileContext } from "../context.js";
import type { TsExtractor } from "../walker.js";

function packageName(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0] ?? spec;
}

function addImport(
  ctx: TsFileContext,
  node: ts.Node,
  spec: string,
  typeOnly: boolean,
  dynamic: boolean,
): void {
  const p = ctx.pos(node);
  const r = ctx.resolveModule(spec);
  const isRelative = spec.startsWith(".") || spec.startsWith("/");
  const f: Parameters<TsFileContext["addImport"]>[0] = {
    specifier: spec,
    typeOnly,
    dynamic,
    computed: false,
    line: p.line,
    column: p.column,
  };
  if (r.resolved) f.resolved = r.resolved;
  else if (!isRelative) f.external = r.external ?? packageName(spec.replace(/^node:/, ""));
  if (r.heuristic) f.heuristic = true;
  ctx.addImport(f);
  if (!r.resolved && isRelative && !/\.(json|css|scss|svg|png|txt)$/.test(spec)) {
    // remember the miss so the cache invalidates if the file appears later
    ctx.facts.deps[`?${spec}`] = "";
  }
}

export const importsExtractor: TsExtractor = {
  id: "core/imports",
  version: "1",
  kinds: ["ImportDeclaration", "ExportDeclaration", "ImportEqualsDeclaration", "CallExpression"],
  visit(node, ctx) {
    const t = ctx.ts;
    if (t.isImportDeclaration(node)) {
      if (!t.isStringLiteral(node.moduleSpecifier)) return;
      const c = node.importClause;
      let typeOnly = !!c?.isTypeOnly;
      if (c && !typeOnly && !c.name && c.namedBindings && t.isNamedImports(c.namedBindings)) {
        const els = c.namedBindings.elements;
        typeOnly = els.length > 0 && els.every((e) => e.isTypeOnly);
      }
      addImport(ctx, node, node.moduleSpecifier.text, typeOnly, false);
      return;
    }
    if (t.isExportDeclaration(node)) {
      if (node.moduleSpecifier && t.isStringLiteral(node.moduleSpecifier)) {
        addImport(ctx, node, node.moduleSpecifier.text, node.isTypeOnly, false);
      }
      return;
    }
    if (t.isImportEqualsDeclaration(node)) {
      const r = node.moduleReference;
      if (t.isExternalModuleReference(r) && t.isStringLiteral(r.expression))
        addImport(ctx, node, r.expression.text, node.isTypeOnly, false);
      return;
    }
    if (t.isCallExpression(node)) {
      const isImport = node.expression.kind === t.SyntaxKind.ImportKeyword;
      const isRequire =
        t.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1;
      if (!isImport && !isRequire) return;
      const a = node.arguments[0];
      if (a && t.isStringLiteralLike(a)) {
        // top-level require is a static dependency; import() and nested require are lazy
        addImport(ctx, node, a.text, false, isImport || ctx.frame.unit.kind !== "module-init");
      } else {
        const p = ctx.pos(node);
        ctx.facts.imports.push({
          specifier: a ? ctx.snippet(a, 80) : "",
          typeOnly: false,
          dynamic: true,
          computed: true,
          line: p.line,
          column: p.column,
        });
        ctx.addLimitation(
          "ARCH_DYNAMIC_IMPORT",
          "dynamic import()/require() with a computed path cannot be resolved statically",
        );
      }
    }
  },
};

export const callsExtractor: TsExtractor = {
  id: "core/calls",
  version: "1",
  kinds: ["CallExpression"],
  visit(node, ctx) {
    const call = node as ts.CallExpression;
    const target = ctx.resolveCallTarget(call);
    if (!target) return;
    const p = ctx.pos(call);
    ctx.frame.unit.calls.push({ target, line: p.line, column: p.column, inLoop: ctx.frame.loop });
  },
};
