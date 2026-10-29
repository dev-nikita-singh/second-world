/**
 * Per-file visit context for TypeScript extractors — docs/04-data-structures-and-algorithms.md §5.10.
 * Holds the lazily-loaded `typescript` module, the Program's TypeChecker (queried lazily, only on
 * candidate nodes), unit (function) tracking, origin resolution ("where does this receiver come
 * from?": `new Pool()` from "pg", `express.Router()`, …) and fact emitters.
 */
import path from "node:path";
import type * as ts from "typescript";
import { sha256 } from "../../../../shared/index.js";
import type {
  ClientFact,
  FileFacts,
  ImportFact,
  RouteFact,
  RuleHit,
  UnitFact,
  UnitKind,
  UseFact,
} from "../../types.js";

export type TsModule = typeof import("typescript");
export type SyntaxKindName = keyof typeof ts.SyntaxKind;

/** Where an expression's value comes from (best effort, static). */
export interface Origin {
  /** Import specifier with "node:" stripped (e.g. "pg", "express", "./db.js" never — relative is followed). */
  module?: string;
  /** Imported name: "default" | "*" | named export; or the global's name. */
  name?: string;
  /** Unresolved or ambient (lib / @types) identifier, e.g. `fetch`, `JSON`. */
  global?: boolean;
  /** Project unit id for local functions/classes. */
  local?: string;
  /** Ends at a function parameter / uninitialised property (DI, runtime wiring). */
  param?: boolean;
  /** Type annotation text of the parameter/property, when present. */
  typeName?: string;
  /** Operations applied after the root: "new", "()", ".prop". */
  steps: string[];
  /** Creation expressions along the chain (CallExpression/NewExpression), in application order. */
  nodes: ts.Node[];
  unknown?: boolean;
}

export interface Frame {
  unit: UnitFact;
  loop: boolean;
}

export interface TsFileContextInit {
  ts: TsModule;
  checker: ts.TypeChecker;
  sf: ts.SourceFile;
  root: string;
  file: string;
  hash: string;
  projectFiles: ReadonlySet<string>;
}

const FN_KINDS_CACHE = new WeakMap<object, Set<number>>();

export class TsFileContext {
  readonly ts: TsModule;
  readonly checker: ts.TypeChecker;
  readonly sf: ts.SourceFile;
  readonly root: string;
  readonly file: string;
  readonly projectFiles: ReadonlySet<string>;
  readonly facts: FileFacts;
  frame!: Frame;
  /** Module resolver installed by the analyzer (project file / external package). */
  resolveModule: (spec: string) => { resolved?: string; external?: string; heuristic?: boolean } = () => ({});
  /** Enabled framework ids ("auto" = all). */
  frameworks: "auto" | readonly string[] = "auto";
  /** Per-file scratch space for extractors (keyed by extractor id). */
  readonly scratch = new Map<string, unknown>();
  private readonly units = new Map<string, UnitFact>();
  private readonly preUnits = new Map<ts.Node, UnitFact>();
  private readonly originCache = new Map<ts.Node, Origin>();
  private useOrder = 0;
  readonly moduleUnit: UnitFact;

  constructor(init: TsFileContextInit) {
    this.ts = init.ts;
    this.checker = init.checker;
    this.sf = init.sf;
    this.root = init.root;
    this.file = init.file;
    this.projectFiles = init.projectFiles;
    this.facts = {
      file: init.file,
      hash: init.hash,
      deps: {},
      language: /\.(c|m)?jsx?$/.test(init.file) ? "javascript" : "typescript",
      imports: [],
      units: [],
      routes: [],
      uses: [],
      clients: [],
      hits: [],
      suppressions: [],
      flags: [],
      limitations: [],
    };
    const end = this.sf.getLineAndCharacterOfPosition(this.sf.end).line + 1;
    this.moduleUnit = {
      id: `${init.file}#<module>`,
      name: "<module>",
      kind: "module-init",
      line: 1,
      endLine: end,
      async: false,
      calls: [],
    };
    this.units.set(this.moduleUnit.id, this.moduleUnit);
    this.frame = { unit: this.moduleUnit, loop: false };
  }

  // ---------------------------------------------------------------- locations

  pos(node: ts.Node): { line: number; column: number; endLine: number } {
    const s = this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf));
    const e = this.sf.getLineAndCharacterOfPosition(node.end);
    return { line: s.line + 1, column: s.character + 1, endLine: e.line + 1 };
  }

  snippet(node: ts.Node, max = 240): string {
    const t = node.getText(this.sf).replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max) : t;
  }

  relFile(sf: ts.SourceFile): string {
    return path.relative(this.root, sf.fileName).split(path.sep).join("/");
  }

  isProjectSource(sf: ts.SourceFile): boolean {
    return this.projectFiles.has(this.relFile(sf));
  }

  // ---------------------------------------------------------------- units

  isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
    const k = this.ts.SyntaxKind;
    let set = FN_KINDS_CACHE.get(this.ts);
    if (!set) {
      set = new Set([
        k.FunctionDeclaration,
        k.FunctionExpression,
        k.ArrowFunction,
        k.MethodDeclaration,
        k.Constructor,
        k.GetAccessor,
        k.SetAccessor,
      ]);
      FN_KINDS_CACHE.set(this.ts, set);
    }
    return set.has(node.kind) && (node as ts.FunctionLikeDeclaration).body !== undefined;
  }

  /** Own name of a unit-defining node, or undefined for anonymous functions / non-units. */
  ownName(n: ts.Node): string | undefined {
    const t = this.ts;
    if (t.isFunctionDeclaration(n) || t.isMethodDeclaration(n) || t.isGetAccessor(n) || t.isSetAccessor(n)) {
      return n.name ? this.nameText(n.name) : undefined;
    }
    if (t.isConstructorDeclaration(n)) return "constructor";
    if (t.isClassDeclaration(n) || t.isClassExpression(n)) return n.name?.text;
    if (t.isArrowFunction(n) || t.isFunctionExpression(n)) {
      if (t.isFunctionExpression(n) && n.name) return n.name.text;
      const p = n.parent;
      if (t.isVariableDeclaration(p) && t.isIdentifier(p.name)) return p.name.text;
      if (t.isPropertyDeclaration(p)) return this.nameText(p.name);
      if (
        t.isPropertyAssignment(p) &&
        t.isObjectLiteralExpression(p.parent) &&
        t.isVariableDeclaration(p.parent.parent)
      ) {
        const v = p.parent.parent;
        return t.isIdentifier(v.name) ? `${v.name.text}.${this.nameText(p.name)}` : undefined;
      }
    }
    return undefined;
  }

  private nameText(n: ts.PropertyName | ts.BindingName): string {
    const t = this.ts;
    if (t.isIdentifier(n) || t.isStringLiteral(n) || t.isNumericLiteral(n) || t.isPrivateIdentifier(n))
      return n.text;
    return n.getText();
  }

  /** Qualified unit name from enclosing named units (deterministic from any file). */
  qualifiedName(fn: ts.Node): string | undefined {
    const own = this.ownName(fn);
    if (own === undefined) return undefined;
    const parts = [own];
    let n: ts.Node | undefined = fn.parent;
    let guard = 0;
    while (n && !this.ts.isSourceFile(n) && guard++ < 200) {
      if (this.isFunctionLike(n) || this.ts.isClassDeclaration(n) || this.ts.isClassExpression(n)) {
        const nm = this.ownName(n);
        if (nm !== undefined) parts.push(nm);
      }
      n = n.parent;
    }
    return parts.reverse().join(".");
  }

  unitIdFor(fn: ts.Node): string | undefined {
    const sf = fn.getSourceFile();
    if (!this.isProjectSource(sf)) return undefined;
    const q = this.qualifiedName(fn);
    return q === undefined ? undefined : `${this.relFile(sf)}#${q}`;
  }

  /** Called by the walker when entering a function-like node; returns the frame for its body. */
  enterFunction(fn: ts.FunctionLikeDeclaration, outer: Frame): Frame {
    const pre = this.preUnits.get(fn);
    if (pre) return { unit: pre, loop: false };
    const id = this.unitIdFor(fn);
    const iterCb = this.isIterationCallback(fn);
    if (id === undefined) return { unit: outer.unit, loop: outer.loop || iterCb };
    let unit = this.units.get(id);
    if (!unit) {
      const p = this.pos(fn);
      unit = {
        id,
        name: id.slice(id.indexOf("#") + 1),
        kind: this.ts.isMethodDeclaration(fn) || this.ts.isConstructorDeclaration(fn) ? "method" : "function",
        line: p.line,
        endLine: p.endLine,
        async: this.isAsync(fn),
        calls: [],
      };
      this.units.set(id, unit);
    }
    return { unit, loop: false };
  }

  isAsync(fn: ts.Node): boolean {
    const mods = (fn as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
    return !!mods?.some((m) => m.kind === this.ts.SyntaxKind.AsyncKeyword);
  }

  /** Arrow/function passed to `.map/.forEach/...` — its body runs once per element. */
  isIterationCallback(fn: ts.Node): boolean {
    const p = fn.parent;
    if (!p || !this.ts.isCallExpression(p) || !p.arguments.includes(fn as ts.Expression)) return false;
    const callee = p.expression;
    return this.ts.isPropertyAccessExpression(callee) && ITERATION_METHODS.has(callee.name.text);
  }

  /**
   * Pre-register an inline function as a handler/consumer unit (called by extractors on the
   * registration call, before the walker enters the function). Returns the unit id.
   */
  registerFunctionUnit(fn: ts.Node, kind: UnitKind, name: string): string {
    const existing = this.preUnits.get(fn);
    if (existing) return existing.id;
    const p = this.pos(fn);
    let id = `${this.file}#${name}`;
    if (this.units.has(id)) id = `${id}@${p.line}`;
    const unit: UnitFact = {
      id,
      name,
      kind,
      line: p.line,
      endLine: p.endLine,
      async: this.isAsync(fn),
      calls: [],
    };
    this.units.set(id, unit);
    this.preUnits.set(fn, unit);
    return id;
  }

  /** Mark an existing named unit (e.g. a Nest controller method) with a kind. */
  markUnit(id: string, kind: UnitKind): void {
    const u = this.units.get(id);
    if (u) u.kind = kind;
  }

  /** Unit id for a handler reference: inline function, identifier, `this.method`, `obj.fn.bind(x)`. */
  unitIdOfExpression(expr: ts.Expression, kind: UnitKind, nameIfInline: string): string | undefined {
    const t = this.ts;
    const e = this.skipOuter(expr);
    if (t.isArrowFunction(e) || t.isFunctionExpression(e))
      return this.registerFunctionUnit(e, kind, nameIfInline);
    if (
      t.isCallExpression(e) &&
      t.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === "bind"
    ) {
      return this.unitIdOfExpression(e.expression.expression, kind, nameIfInline);
    }
    if (t.isIdentifier(e) || t.isPropertyAccessExpression(e)) {
      const fn = this.resolveFunctionDecl(e);
      return fn ? this.unitIdFor(fn) : undefined;
    }
    return undefined;
  }

  units_(): UnitFact[] {
    return [...this.units.values()];
  }

  // ---------------------------------------------------------------- symbols

  skipOuter(e: ts.Expression): ts.Expression {
    const t = this.ts;
    let x = e;
    for (let i = 0; i < 20; i++) {
      if (
        t.isParenthesizedExpression(x) ||
        t.isAsExpression(x) ||
        t.isNonNullExpression(x) ||
        t.isTypeAssertionExpression(x) ||
        t.isSatisfiesExpression(x) ||
        t.isAwaitExpression(x)
      ) {
        x = x.expression;
      } else break;
    }
    return x;
  }

  symbolAt(node: ts.Node): ts.Symbol | undefined {
    try {
      return this.checker.getSymbolAtLocation(node);
    } catch {
      return undefined;
    }
  }

  private dealias(sym: ts.Symbol): ts.Symbol {
    if (sym.flags & this.ts.SymbolFlags.Alias) {
      try {
        const a = this.checker.getAliasedSymbol(sym);
        if (a?.declarations && a.declarations.length > 0) return a;
      } catch {
        // unknown symbol
      }
    }
    return sym;
  }

  /** Resolve an identifier/property access to the function-like declaration it denotes (project only). */
  resolveFunctionDecl(expr: ts.Expression): ts.FunctionLikeDeclaration | undefined {
    const t = this.ts;
    const nameNode = t.isPropertyAccessExpression(expr) ? expr.name : expr;
    const s0 = this.symbolAt(nameNode);
    if (!s0) return undefined;
    const s = this.dealias(s0);
    const decls = s.declarations ?? [];
    for (const d of decls) {
      if (!this.isProjectSource(d.getSourceFile())) continue;
      if (this.isFunctionLike(d)) return d;
      if (
        (t.isVariableDeclaration(d) || t.isPropertyDeclaration(d) || t.isPropertyAssignment(d)) &&
        d.initializer
      ) {
        const init = this.skipOuter(d.initializer);
        if (this.isFunctionLike(init)) return init;
      }
    }
    return undefined;
  }

  /** Unit id of the call's target when it is a project function/method. */
  resolveCallTarget(call: ts.CallExpression): string | undefined {
    const callee = this.skipOuter(call.expression);
    if (!this.ts.isIdentifier(callee) && !this.ts.isPropertyAccessExpression(callee)) return undefined;
    const fn = this.resolveFunctionDecl(callee);
    return fn ? this.unitIdFor(fn) : undefined;
  }

  /** Name of the class declaring a project method the call resolves to (e.g. "Db"), plus the method name. */
  resolveMethodOwner(
    call: ts.CallExpression,
  ): { className: string; method: string; file: string } | undefined {
    const callee = this.skipOuter(call.expression);
    if (!this.ts.isPropertyAccessExpression(callee)) return undefined;
    const fn = this.resolveFunctionDecl(callee);
    if (!fn || !this.ts.isMethodDeclaration(fn)) return undefined;
    const cls = fn.parent;
    if (!(this.ts.isClassDeclaration(cls) || this.ts.isClassExpression(cls)) || !cls.name) return undefined;
    return { className: cls.name.text, method: callee.name.text, file: this.relFile(fn.getSourceFile()) };
  }

  // ---------------------------------------------------------------- origins

  originOf(expr: ts.Expression): Origin {
    const cached = this.originCache.get(expr);
    if (cached) return cached;
    const o = this.computeOrigin(expr, 0, new Set());
    this.originCache.set(expr, o);
    return o;
  }

  private computeOrigin(expr0: ts.Expression, depth: number, seen: Set<ts.Node>): Origin {
    const t = this.ts;
    if (depth > 12) return { unknown: true, steps: [], nodes: [] };
    const expr = this.skipOuter(expr0);
    if (t.isIdentifier(expr)) {
      const sym0 = this.symbolAt(expr);
      if (!sym0?.declarations || sym0.declarations.length === 0) {
        return { global: true, name: expr.text, steps: [], nodes: [] };
      }
      return this.originOfSymbol(sym0, expr.text, depth, seen);
    }
    if (t.isPropertyAccessExpression(expr)) {
      if (expr.expression.kind === t.SyntaxKind.ThisKeyword) {
        const s = this.symbolAt(expr.name);
        if (s) return this.originOfSymbol(s, expr.name.text, depth, seen);
        return { unknown: true, steps: [], nodes: [] };
      }
      const base = this.computeOrigin(expr.expression, depth + 1, seen);
      if (base.param || base.unknown) {
        // try the property's own declaration (e.g. object property with initializer)
        const s = this.symbolAt(expr.name);
        const d = s?.declarations?.[0];
        if (
          d &&
          this.isProjectSource(d.getSourceFile()) &&
          (t.isPropertyDeclaration(d) || t.isPropertyAssignment(d)) &&
          d.initializer &&
          !seen.has(d)
        ) {
          seen.add(d);
          return this.computeOrigin(d.initializer, depth + 1, seen);
        }
      }
      return { ...base, steps: [...base.steps, `.${expr.name.text}`], nodes: base.nodes };
    }
    if (t.isCallExpression(expr)) {
      if (
        t.isIdentifier(expr.expression) &&
        expr.expression.text === "require" &&
        expr.arguments.length === 1
      ) {
        const a = expr.arguments[0] as ts.Expression;
        if (t.isStringLiteralLike(a)) return this.moduleOrigin(a.text, "*");
      }
      const base = this.computeOrigin(expr.expression, depth + 1, seen);
      return { ...base, steps: [...base.steps, "()"], nodes: [...base.nodes, expr] };
    }
    if (t.isNewExpression(expr)) {
      const base = this.computeOrigin(expr.expression, depth + 1, seen);
      return { ...base, steps: [...base.steps, "new"], nodes: [...base.nodes, expr] };
    }
    return { unknown: true, steps: [], nodes: [] };
  }

  private moduleOrigin(spec: string, name: string): Origin {
    return { module: spec.replace(/^node:/, ""), name, steps: [], nodes: [] };
  }

  private originOfSymbol(sym0: ts.Symbol, text: string, depth: number, seen: Set<ts.Node>): Origin {
    const t = this.ts;
    const decl = sym0.declarations?.[0];
    if (!decl) return { global: true, name: text, steps: [], nodes: [] };
    // Import bindings
    if (
      t.isImportSpecifier(decl) ||
      t.isImportClause(decl) ||
      t.isNamespaceImport(decl) ||
      t.isImportEqualsDeclaration(decl)
    ) {
      let spec: string | undefined;
      let imported = "default";
      if (t.isImportSpecifier(decl)) {
        imported = (decl.propertyName ?? decl.name).text;
        spec = (decl.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text;
      } else if (t.isImportClause(decl)) {
        spec = (decl.parent.moduleSpecifier as ts.StringLiteral).text;
      } else if (t.isNamespaceImport(decl)) {
        imported = "*";
        spec = (decl.parent.parent.moduleSpecifier as ts.StringLiteral).text;
      } else if (
        t.isExternalModuleReference(decl.moduleReference) &&
        t.isStringLiteral(decl.moduleReference.expression)
      ) {
        imported = "*";
        spec = decl.moduleReference.expression.text;
      }
      if (spec === undefined) return { unknown: true, steps: [], nodes: [] };
      const target = this.dealias(sym0);
      const td = target !== sym0 ? target.declarations?.[0] : undefined;
      if (td && this.isProjectSource(td.getSourceFile()))
        return this.originOfDecl(td, target.name, depth, seen);
      return this.moduleOrigin(spec, imported);
    }
    if (!this.isProjectSource(decl.getSourceFile()))
      return { global: true, name: text, steps: [], nodes: [] };
    return this.originOfDecl(decl, text, depth, seen);
  }

  private originOfDecl(decl: ts.Declaration, text: string, depth: number, seen: Set<ts.Node>): Origin {
    const t = this.ts;
    if (seen.has(decl)) return { unknown: true, steps: [], nodes: [] };
    seen.add(decl);
    if (t.isVariableDeclaration(decl)) {
      if (decl.initializer) {
        if (this.isFunctionLike(this.skipOuter(decl.initializer))) {
          const id = this.unitIdFor(this.skipOuter(decl.initializer));
          return id ? { local: id, steps: [], nodes: [] } : { unknown: true, steps: [], nodes: [] };
        }
        return this.computeOrigin(decl.initializer, depth + 1, seen);
      }
      const o: Origin = { param: true, name: text, steps: [], nodes: [] };
      if (decl.type) o.typeName = decl.type.getText();
      return o;
    }
    if (t.isBindingElement(decl)) {
      const prop = decl.propertyName ? decl.propertyName.getText() : decl.name.getText();
      let p: ts.Node = decl.parent;
      while (p && (t.isObjectBindingPattern(p) || t.isArrayBindingPattern(p) || t.isBindingElement(p)))
        p = p.parent;
      if (t.isVariableDeclaration(p) && p.initializer) {
        const base = this.computeOrigin(p.initializer, depth + 1, seen);
        if (base.module && base.steps.length === 0 && base.name === "*") return { ...base, name: prop };
        return { ...base, steps: [...base.steps, `.${prop}`] };
      }
      return { param: true, name: text, steps: [], nodes: [] };
    }
    if (t.isParameter(decl)) {
      const o: Origin = { param: true, name: text, steps: [], nodes: [] };
      if (decl.type) o.typeName = decl.type.getText();
      return o;
    }
    if (t.isPropertyDeclaration(decl)) {
      if (decl.initializer) return this.computeOrigin(decl.initializer, depth + 1, seen);
      const o: Origin = { param: true, name: text, steps: [], nodes: [] };
      if (decl.type) o.typeName = decl.type.getText();
      return o;
    }
    if (this.isFunctionLike(decl) || t.isClassDeclaration(decl)) {
      const id = this.unitIdFor(decl);
      return id ? { local: id, steps: [], nodes: [] } : { unknown: true, steps: [], nodes: [] };
    }
    return { unknown: true, steps: [], nodes: [] };
  }

  // ---------------------------------------------------------------- literal helpers

  /** String value of a literal / no-substitution template; template with substitutions → head + "*" pieces. */
  stringValue(e: ts.Expression | undefined): string | undefined {
    if (!e) return undefined;
    const t = this.ts;
    const x = this.skipOuter(e);
    if (t.isStringLiteralLike(x)) return x.text;
    if (t.isTemplateExpression(x))
      return (
        x.head.text +
        x.templateSpans.map((s) => `\${${s.expression.getText(this.sf)}}${s.literal.text}`).join("")
      );
    if (t.isIdentifier(x)) {
      const s = this.symbolAt(x);
      const d = s?.declarations?.[0];
      if (d && t.isVariableDeclaration(d) && d.initializer && t.isStringLiteralLike(d.initializer))
        return d.initializer.text;
    }
    return undefined;
  }

  /** Object literal for an expression (direct, or via a const in the project); undefined if unknown. */
  objectLiteral(e: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
    if (!e) return undefined;
    const t = this.ts;
    const x = this.skipOuter(e);
    if (t.isObjectLiteralExpression(x)) return x;
    if (t.isIdentifier(x)) {
      const s = this.symbolAt(x);
      const d = s?.declarations?.[0];
      if (d && t.isVariableDeclaration(d) && d.initializer && this.isProjectSource(d.getSourceFile())) {
        const init = this.skipOuter(d.initializer);
        if (t.isObjectLiteralExpression(init)) return init;
      }
    }
    return undefined;
  }

  /** Property names of an object literal; `spread` true when it has spreads (unknown keys). */
  objectProps(obj: ts.ObjectLiteralExpression): {
    props: Map<string, ts.Expression | undefined>;
    spread: boolean;
  } {
    const t = this.ts;
    const props = new Map<string, ts.Expression | undefined>();
    let spread = false;
    for (const p of obj.properties) {
      if (t.isSpreadAssignment(p)) spread = true;
      else if (t.isPropertyAssignment(p)) props.set(this.nameText(p.name), p.initializer);
      else if (t.isShorthandPropertyAssignment(p)) props.set(p.name.text, p.name);
      else if (t.isMethodDeclaration(p)) props.set(this.nameText(p.name), undefined);
    }
    return { props, spread };
  }

  /** Name of a middleware-ish argument: `auth`, `auth.required`, `requireRole("admin")` → "requireRole". */
  exprName(e: ts.Expression): string | undefined {
    const t = this.ts;
    const x = this.skipOuter(e);
    if (t.isIdentifier(x)) return x.text;
    if (t.isPropertyAccessExpression(x)) return x.getText(this.sf).replace(/\s+/g, "");
    if (t.isCallExpression(x)) return this.exprName(x.expression);
    if (t.isArrayLiteralExpression(x)) return x.elements.map((el) => this.exprName(el) ?? "?").join(",");
    return undefined;
  }

  // ---------------------------------------------------------------- emitters

  addImport(f: ImportFact): void {
    this.facts.imports.push(f);
    if (f.resolved) this.facts.deps[f.resolved] = "";
  }

  addRoute(r: Omit<RouteFact, "line" | "column">, node: ts.Node): void {
    const p = this.pos(node);
    this.facts.routes.push({ ...r, line: p.line, column: p.column });
  }

  addUse(u: Omit<UseFact, "line" | "order">, node: ts.Node): void {
    this.facts.uses.push({ ...u, line: this.pos(node).line, order: this.useOrder++ });
  }

  addClient(
    c: Omit<ClientFact, "unit" | "line" | "column" | "endLine" | "inLoop" | "snippet">,
    node: ts.Node,
    unitOverride?: string,
  ): void {
    const p = this.pos(node);
    this.facts.clients.push({
      ...c,
      unit: unitOverride ?? this.frame.unit.id,
      line: p.line,
      column: p.column,
      endLine: p.endLine,
      inLoop: this.frame.loop,
      snippet: this.snippet(node),
    });
  }

  addHit(
    h: Omit<RuleHit, "unit" | "symbol" | "line" | "column" | "endLine" | "snippet"> & { snippet?: string },
    node: ts.Node,
  ): void {
    const p = this.pos(node);
    const unit = this.frame.unit;
    this.facts.hits.push({
      ...h,
      unit: unit.id,
      symbol: unit.name,
      line: p.line,
      column: p.column,
      endLine: p.endLine,
      snippet: h.snippet ?? this.snippet(node),
    });
  }

  addFlag(flag: string): void {
    if (!this.facts.flags.includes(flag)) this.facts.flags.push(flag);
  }

  addLimitation(code: string, message: string): void {
    if (!this.facts.limitations.some((l) => l.code === code)) this.facts.limitations.push({ code, message });
  }

  /** Owner identity of a router/app expression: `<file>#<enclosing unit>:<var>`. */
  ownerKey(e: ts.Expression): string {
    const t = this.ts;
    const x = this.skipOuter(e);
    if (t.isIdentifier(x)) {
      const s0 = this.symbolAt(x);
      const s = s0 ? this.dealias(s0) : undefined;
      const d = s?.declarations?.[0];
      if (d && this.isProjectSource(d.getSourceFile())) {
        let n: ts.Node | undefined = d.parent;
        let enclosing = "<module>";
        while (n && !t.isSourceFile(n)) {
          const pre = this.preUnits.get(n);
          if (pre) {
            enclosing = pre.name;
            break;
          }
          if (this.isFunctionLike(n)) {
            const q = this.qualifiedName(n);
            if (q !== undefined) {
              enclosing = q;
              break;
            }
          }
          n = n.parent;
        }
        return `${this.relFile(d.getSourceFile())}#${enclosing}:${x.text}`;
      }
      return `${this.file}#${this.frame.unit.name}:${x.text}`;
    }
    return `${this.file}#${this.frame.unit.name}:${this.snippet(x, 60)}`;
  }

  hashText(s: string): string {
    return sha256(s).slice(0, 16);
  }

  finalize(): FileFacts {
    this.facts.units = this.units_();
    return this.facts;
  }
}

export const ITERATION_METHODS = new Set([
  "forEach",
  "map",
  "flatMap",
  "filter",
  "reduce",
  "reduceRight",
  "some",
  "every",
  "find",
  "findIndex",
]);
