/**
 * Hand-written request dispatch on plain `node:http` (framework id "node-http") —
 * docs/03-engines/architecture-inspector.md §1.3. Recognised patterns, each with a confidence:
 *
 *   0.7  project router object/class: `router.get("/x", h)`, `r.add("GET", "/x", h)` where the method
 *        resolves to a function declared in the project (not a library's Map/client)
 *   0.7  route tables: `{ "GET /x": h }`, `[{ method: "GET", path: "/x" | /^\/x$/, handler: h }]`,
 *        `[["GET", "/x", h]]`
 *   0.6  conditionals: `if (method === "GET" && path === "/x")`, regex tests/`match`/`exec` on the path,
 *        `switch` on the method, the path or a `${method} ${path}` key, and nestings of these
 *   0.5  `if (path === "/x")` without any method check, only inside a function that also dispatches
 *        on method + path (reported as method ALL)
 *
 * Regex paths become `:name` (named groups) / `:pN` (other groups) parameters; regexes that do not
 * reduce to a path (alternations, character classes outside groups) are skipped. No recursion on
 * user-sized input: parent walks and subtree scans are bounded.
 */
import type * as ts from "typescript";
import type { TsFileContext } from "../context.js";
import type { TsExtractor } from "../walker.js";

export const NODE_HTTP_FRAMEWORK = "node-http";
const EXTRACTOR = `framework/${NODE_HTTP_FRAMEWORK}`;

const VERB_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;
const ROUTE_KEY_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/i;
const VERB_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const ADD_METHODS = new Set(["add", "addRoute", "route", "on", "register", "handle", "define", "map"]);
const METHOD_NAME_RE = /^(method|verb|httpMethod|reqMethod|requestMethod|m)$/i;
const PATH_NAME_RE = /^(path|pathname|pathName|url|uri|route|routePath|reqPath|requestPath|p)$/i;
const PATH_PROP_RE = /^(path|pathname|url)$/;
const HANDLER_PROPS = ["handler", "handle", "fn", "action", "run", "controller", "callback", "cb"];
const PATH_PROPS = ["path", "pattern", "url", "route", "regex", "re", "match"];

function enabled(ctx: TsFileContext): boolean {
  return ctx.frameworks === "auto" || ctx.frameworks.includes(NODE_HTTP_FRAMEWORK);
}

function routeParams(p: string): string[] {
  return [...p.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
}

/**
 * Regex source (`^\/orders\/(?<id>\d+)\/?$`) → route path (`/orders/:id`), or undefined when the
 * regex does not describe one path. Iterative scan with a depth counter (groups may nest).
 */
export function regexToPath(source: string): string | undefined {
  let s = source;
  if (!s.startsWith("^")) return undefined;
  s = s.slice(1);
  if (s.endsWith("$")) s = s.slice(0, -1);
  s = s.replace(/\\\/\?$/, "").replace(/\/\?$/, "");
  let out = "";
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === "\\") {
      const nx = s[i + 1];
      if (nx === undefined) return undefined;
      if (/[/.\-_~]/.test(nx)) {
        out += nx;
        i++;
        continue;
      }
      return undefined; // \d, \w … outside a group: not a fixed path
    }
    if (ch === "(") {
      // capture group → parameter; find its end with a depth counter
      let depth = 1;
      let j = i + 1;
      for (; j < s.length && depth > 0; j++) {
        const c = s[j];
        if (c === "\\") j++;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      if (depth !== 0) return undefined;
      const inner = s.slice(i + 1, j - 1);
      if (inner.startsWith("?:")) return undefined; // non-capturing alternation etc.
      const named = /^\?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(inner);
      n++;
      out += `:${named ? named[1] : `p${n}`}`;
      i = j - 1;
      continue;
    }
    if (ch === "." && s[i + 1] === "*") {
      out += "*";
      i++;
      continue;
    }
    if (/[[\]|+*?{}^$.]/.test(ch)) return undefined;
    out += ch;
  }
  return out.startsWith("/") ? out : undefined;
}

/** Path string or regex literal (directly, or via a project const) → route path. */
function pathOf(ctx: TsFileContext, e: ts.Expression | undefined): string | undefined {
  if (!e) return undefined;
  const t = ctx.ts;
  let x = ctx.skipOuter(e);
  if (t.isIdentifier(x)) {
    const d = ctx.symbolAt(x)?.declarations?.[0];
    if (d && t.isVariableDeclaration(d) && d.initializer && ctx.isProjectSource(d.getSourceFile()))
      x = ctx.skipOuter(d.initializer);
  }
  if (t.isRegularExpressionLiteral(x)) {
    const m = /^\/(.*)\/[a-z]*$/s.exec(x.text);
    return m ? regexToPath(m[1] as string) : undefined;
  }
  if (t.isNewExpression(x) && t.isIdentifier(x.expression) && x.expression.text === "RegExp") {
    const src = ctx.stringValue(x.arguments?.[0]);
    return src === undefined ? undefined : regexToPath(src);
  }
  const s = ctx.stringValue(x);
  return s?.startsWith("/") && !s.includes("${") ? s : undefined;
}

/** `req.method`, `method`, `req.method.toUpperCase()`, `(req.method ?? "GET")`. */
function isMethodExpr(ctx: TsFileContext, e: ts.Expression): boolean {
  const x = unwrap(ctx, e);
  const t = ctx.ts;
  if (t.isIdentifier(x)) return METHOD_NAME_RE.test(x.text);
  if (t.isPropertyAccessExpression(x)) return x.name.text === "method";
  return false;
}

/** `path`, `url.pathname`, `req.url`, `pathname.toLowerCase()`. */
function isPathExpr(ctx: TsFileContext, e: ts.Expression): boolean {
  const x = unwrap(ctx, e);
  const t = ctx.ts;
  if (t.isIdentifier(x)) return PATH_NAME_RE.test(x.text);
  if (t.isPropertyAccessExpression(x)) return PATH_PROP_RE.test(x.name.text);
  return false;
}

function unwrap(ctx: TsFileContext, e: ts.Expression): ts.Expression {
  const t = ctx.ts;
  let x = ctx.skipOuter(e);
  for (let i = 0; i < 5; i++) {
    if (
      t.isCallExpression(x) &&
      x.arguments.length === 0 &&
      t.isPropertyAccessExpression(x.expression) &&
      /^(toUpperCase|toLowerCase|trim)$/.test(x.expression.name.text)
    ) {
      x = ctx.skipOuter(x.expression.expression);
    } else if (
      t.isBinaryExpression(x) &&
      (x.operatorToken.kind === t.SyntaxKind.QuestionQuestionToken ||
        x.operatorToken.kind === t.SyntaxKind.BarBarToken)
    ) {
      x = ctx.skipOuter(x.left);
    } else break;
  }
  return x;
}

interface Facts {
  methods: string[];
  paths: string[];
  /** Combined "GET /x" keys (from `${method} ${path}` comparisons). */
  keys: { method: string; path: string }[];
}

const EQ = (ctx: TsFileContext, k: ts.SyntaxKind) =>
  k === ctx.ts.SyntaxKind.EqualsEqualsEqualsToken || k === ctx.ts.SyntaxKind.EqualsEqualsToken;

/** Is `e` a `${method} ${path}`-style key (template or concatenation of a method and a path expr)? */
function isRouteKeyExpr(ctx: TsFileContext, e: ts.Expression): boolean {
  const t = ctx.ts;
  const x = ctx.skipOuter(e);
  if (t.isTemplateExpression(x)) {
    const spans = x.templateSpans.map((s) => s.expression);
    return spans.some((s) => isMethodExpr(ctx, s)) && spans.some((s) => isPathExpr(ctx, s));
  }
  if (t.isIdentifier(x)) return /^(key|routeKey|route|signature|sig)$/i.test(x.text);
  return false;
}

/** Method/path facts of one comparison or test. */
function atomFacts(ctx: TsFileContext, e: ts.Expression, f: Facts): void {
  const t = ctx.ts;
  let x = ctx.skipOuter(e);
  if (t.isBinaryExpression(x) && EQ(ctx, x.operatorToken.kind)) {
    for (const [a, b] of [
      [x.left, x.right],
      [x.right, x.left],
    ] as const) {
      const lit = ctx.stringValue(b);
      if (lit === undefined) continue;
      if (VERB_RE.test(lit) && isMethodExpr(ctx, a)) f.methods.push(lit.toUpperCase());
      else if (lit.startsWith("/") && isPathExpr(ctx, a)) f.paths.push(lit);
      else if (isRouteKeyExpr(ctx, a)) {
        const m = ROUTE_KEY_RE.exec(lit);
        if (m) f.keys.push({ method: (m[1] as string).toUpperCase(), path: m[2] as string });
      }
    }
    return;
  }
  // `m` where `const m = RE.exec(path)` / `path.match(RE)`
  if (t.isIdentifier(x)) {
    const d = ctx.symbolAt(x)?.declarations?.[0];
    if (!d || !t.isVariableDeclaration(d) || !d.initializer || d.getSourceFile() !== ctx.sf) return;
    x = ctx.skipOuter(d.initializer);
  }
  if (t.isCallExpression(x) && t.isPropertyAccessExpression(x.expression)) {
    const nm = x.expression.name.text;
    const recv = x.expression.expression;
    const arg = x.arguments[0];
    if ((nm === "test" || nm === "exec") && arg && isPathExpr(ctx, arg)) {
      const p = pathOf(ctx, recv);
      if (p) f.paths.push(p);
    } else if (nm === "match" && arg && isPathExpr(ctx, recv)) {
      const p = pathOf(ctx, arg);
      if (p) f.paths.push(p);
    }
  }
}

/** Facts of an `if` condition: conjuncts of `&&`, each possibly an `||` of same-kind atoms. */
function conditionFacts(ctx: TsFileContext, cond: ts.Expression): Facts {
  const t = ctx.ts;
  const f: Facts = { methods: [], paths: [], keys: [] };
  const stack: ts.Expression[] = [cond];
  let guard = 0;
  while (stack.length > 0 && guard++ < 64) {
    const x = ctx.skipOuter(stack.pop() as ts.Expression);
    if (
      t.isBinaryExpression(x) &&
      (x.operatorToken.kind === t.SyntaxKind.AmpersandAmpersandToken ||
        x.operatorToken.kind === t.SyntaxKind.BarBarToken)
    ) {
      stack.push(x.right, x.left);
      continue;
    }
    atomFacts(ctx, x, f);
  }
  return f;
}

interface Ctx {
  methods: string[];
  paths: string[];
  /** The node that contributed the path (marked "used" when a nested method check completes it). */
  pathNode?: ts.Node;
}

/** Method/path context from enclosing `if` / `case` up to the enclosing function. */
function enclosingContext(ctx: TsFileContext, node: ts.Node): Ctx {
  const t = ctx.ts;
  const c: Ctx = { methods: [], paths: [] };
  let child: ts.Node = node;
  let n: ts.Node | undefined = node.parent;
  for (let guard = 0; n && guard < 64 && !ctx.isFunctionLike(n) && !t.isSourceFile(n); guard++) {
    if (t.isIfStatement(n) && n.thenStatement === child) {
      const f = conditionFacts(ctx, n.expression);
      if (c.methods.length === 0 && f.methods.length > 0) c.methods = f.methods;
      if (c.paths.length === 0 && f.paths.length > 0) {
        c.paths = f.paths;
        c.pathNode = n;
      }
    } else if (t.isCaseClause(n) && t.isCaseBlock(n.parent) && t.isSwitchStatement(n.parent.parent)) {
      const sw = n.parent.parent;
      const lit = ctx.stringValue(n.expression);
      if (lit !== undefined) {
        if (c.methods.length === 0 && VERB_RE.test(lit) && isMethodExpr(ctx, sw.expression))
          c.methods = [lit.toUpperCase()];
        else if (c.paths.length === 0 && lit.startsWith("/") && isPathExpr(ctx, sw.expression)) {
          c.paths = [lit];
          c.pathNode = n;
        }
      }
    }
    child = n;
    n = n.parent;
  }
  return c;
}

interface DispatchState {
  /** Units that dispatch on method + path. */
  dispatchers: Set<string>;
  /** Path-only candidates: node → info. */
  pending: { node: ts.Node; unit: string; paths: string[]; handlerFrom: ts.Node }[];
  used: Set<ts.Node>;
}

function state(ctx: TsFileContext): DispatchState {
  let s = ctx.scratch.get(EXTRACTOR) as DispatchState | undefined;
  if (!s) {
    s = { dispatchers: new Set(), pending: [], used: new Set() };
    ctx.scratch.set(EXTRACTOR, s);
  }
  return s;
}

/**
 * Handler of a branch: the awaited / returned / only project call in it (outside nested functions),
 * else the enclosing unit.
 */
function branchHandler(ctx: TsFileContext, body: ts.Node): string | undefined {
  const t = ctx.ts;
  const awaited: string[] = [];
  const returned: string[] = [];
  const all: string[] = [];
  const stack: ts.Node[] = [body];
  let n = 0;
  while (stack.length > 0 && n++ < 2000) {
    const x = stack.pop() as ts.Node;
    if (x !== body && ctx.isFunctionLike(x)) continue;
    if (t.isCallExpression(x)) {
      const target = ctx.resolveCallTarget(x);
      if (target) {
        all.push(target);
        if (t.isAwaitExpression(x.parent)) awaited.push(target);
        if (
          t.isReturnStatement(x.parent) ||
          (t.isAwaitExpression(x.parent) && t.isReturnStatement(x.parent.parent))
        )
          returned.push(target);
      }
    }
    const kids: ts.Node[] = [];
    t.forEachChild(x, (c) => {
      kids.push(c);
    });
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as ts.Node);
  }
  const uniq = [...new Set(all)];
  return returned[0] ?? awaited[0] ?? (uniq.length === 1 ? uniq[0] : undefined) ?? ctx.frame.unit.id;
}

function emit(
  ctx: TsFileContext,
  at: ts.Node,
  method: string,
  path: string,
  handler: string | undefined,
  confidence: number,
): void {
  const r: Parameters<TsFileContext["addRoute"]>[0] = {
    framework: NODE_HTTP_FRAMEWORK,
    method: method.toUpperCase(),
    path,
    owner: `${ctx.file}#${ctx.frame.unit.name}:${NODE_HTTP_FRAMEWORK}`,
    middlewares: [],
    auth: false,
    params: routeParams(path),
    extractor: EXTRACTOR,
    confidence,
  };
  if (handler) r.handler = handler;
  ctx.addRoute(r, at);
}

function handlerRef(ctx: TsFileContext, e: ts.Expression | undefined, name: string): string | undefined {
  if (!e) return undefined;
  const x = ctx.skipOuter(e);
  if (ctx.isFunctionLike(x)) return ctx.unitIdOfExpression(x, "handler", name);
  const t = ctx.ts;
  if (t.isIdentifier(x) || t.isPropertyAccessExpression(x)) {
    const fn = ctx.resolveFunctionDecl(x);
    return fn ? ctx.unitIdFor(fn) : undefined;
  }
  if (
    t.isCallExpression(x) &&
    t.isPropertyAccessExpression(x.expression) &&
    x.expression.name.text === "bind"
  )
    return handlerRef(ctx, x.expression.expression, name);
  return undefined;
}

// ------------------------------------------------------------------ router objects

function visitCall(ctx: TsFileContext, call: ts.CallExpression): void {
  const t = ctx.ts;
  const callee = call.expression;
  if (!t.isPropertyAccessExpression(callee)) return;
  const name = callee.name.text;
  const isVerb = VERB_METHODS.has(name);
  if (!isVerb && !ADD_METHODS.has(name)) return;
  const args = call.arguments;
  if (args.length < 2) return;
  // The router method must be the project's own (a library Map/HTTP client is not a router).
  const decl = ctx.resolveFunctionDecl(callee);
  if (!decl) return;
  let method: string;
  let path: string | undefined;
  if (isVerb) {
    method = name === "all" ? "ALL" : name.toUpperCase();
    path = pathOf(ctx, args[0]);
  } else {
    const m = ctx.stringValue(args[0]);
    if (m === undefined || !VERB_RE.test(m) || args.length < 3) return;
    method = m.toUpperCase();
    path = pathOf(ctx, args[1]);
  }
  if (path === undefined) return;
  const h = handlerRef(ctx, args[args.length - 1], `${method} ${path}`);
  if (!h) return;
  emit(ctx, call, method, path, h, 0.7);
}

// ------------------------------------------------------------------ route tables

function visitObject(ctx: TsFileContext, obj: ts.ObjectLiteralExpression): void {
  const t = ctx.ts;
  // An options object passed to a library call (`fastify.route({ method, url, handler })`) belongs
  // to that library's extractor.
  const parent = obj.parent;
  if (parent && t.isCallExpression(parent) && parent.arguments.includes(obj)) {
    const callee = ctx.skipOuter(parent.expression);
    if ((t.isIdentifier(callee) || t.isPropertyAccessExpression(callee)) && !ctx.resolveFunctionDecl(callee))
      return;
  }
  // { "GET /x": handler, … }
  for (const p of obj.properties) {
    if (!t.isPropertyAssignment(p) && !t.isMethodDeclaration(p)) continue;
    const key =
      t.isStringLiteral(p.name) || t.isNoSubstitutionTemplateLiteral(p.name) ? p.name.text : undefined;
    const m = key === undefined ? undefined : ROUTE_KEY_RE.exec(key);
    if (!m) continue;
    const method = (m[1] as string).toUpperCase();
    const path = m[2] as string;
    const h = t.isMethodDeclaration(p)
      ? ctx.unitIdFor(p)
      : handlerRef(ctx, p.initializer, `${method} ${path}`);
    if (h) emit(ctx, p, method, path, h, 0.7);
  }
  // { method: "GET", path: "/x" | /re/, handler }
  const { props } = ctx.objectProps(obj);
  const mExpr = props.get("method");
  if (!mExpr) return;
  const methods: string[] = [];
  const mx = ctx.skipOuter(mExpr);
  if (t.isArrayLiteralExpression(mx)) {
    for (const el of mx.elements) {
      const v = ctx.stringValue(el);
      if (v && VERB_RE.test(v)) methods.push(v.toUpperCase());
    }
  } else {
    const v = ctx.stringValue(mExpr);
    if (v && VERB_RE.test(v)) methods.push(v.toUpperCase());
  }
  if (methods.length === 0) return;
  const pathKey = PATH_PROPS.find((k) => props.has(k));
  const path = pathKey ? pathOf(ctx, props.get(pathKey)) : undefined;
  if (path === undefined) return;
  const hKey = HANDLER_PROPS.find((k) => props.has(k));
  if (!hKey) return;
  const hExpr = props.get(hKey);
  let h: string | undefined;
  if (hExpr) h = handlerRef(ctx, hExpr, `${methods[0]} ${path}`);
  else {
    const md = obj.properties.find(
      (p) =>
        t.isMethodDeclaration(p) &&
        (t.isIdentifier(p.name) || t.isStringLiteral(p.name)) &&
        p.name.text === hKey,
    );
    h = md ? ctx.unitIdFor(md) : undefined;
  }
  if (!h) return;
  for (const method of methods) emit(ctx, obj, method, path, h, 0.7);
}

/** `["GET", "/x", handler]` / `["GET /x", handler]` table rows. */
function visitArray(ctx: TsFileContext, arr: ts.ArrayLiteralExpression): void {
  const els = arr.elements;
  if (els.length === 3) {
    const m = ctx.stringValue(els[0]);
    if (m === undefined || !VERB_RE.test(m)) return;
    const path = pathOf(ctx, els[1]);
    if (path === undefined) return;
    const h = handlerRef(ctx, els[2], `${m.toUpperCase()} ${path}`);
    if (h) emit(ctx, arr, m, path, h, 0.7);
  } else if (els.length === 2) {
    const k = ctx.stringValue(els[0]);
    const mm = k === undefined ? undefined : ROUTE_KEY_RE.exec(k);
    if (!mm) return;
    const h = handlerRef(ctx, els[1], k as string);
    if (h) emit(ctx, arr, mm[1] as string, mm[2] as string, h, 0.7);
  }
}

// ------------------------------------------------------------------ conditionals

function visitIf(ctx: TsFileContext, node: ts.IfStatement): void {
  const f = conditionFacts(ctx, node.expression);
  const st = state(ctx);
  const unit = ctx.frame.unit.id;
  for (const k of f.keys) {
    st.dispatchers.add(unit);
    emit(ctx, node, k.method, k.path, branchHandler(ctx, node.thenStatement), 0.6);
  }
  if (f.methods.length === 0 && f.paths.length === 0) return;
  const outer = enclosingContext(ctx, node);
  const methods = f.methods.length > 0 ? f.methods : outer.methods;
  const paths = f.paths.length > 0 ? f.paths : outer.paths;
  if (methods.length > 0 && paths.length > 0) {
    st.dispatchers.add(unit);
    if (f.paths.length === 0 && outer.pathNode) st.used.add(outer.pathNode);
    const h = branchHandler(ctx, node.thenStatement);
    for (const m of methods) for (const p of paths) emit(ctx, node, m, p, h, 0.6);
    return;
  }
  if (f.paths.length > 0 && methods.length === 0)
    st.pending.push({ node, unit, paths: f.paths, handlerFrom: node.thenStatement });
}

function visitSwitch(ctx: TsFileContext, node: ts.SwitchStatement): void {
  const t = ctx.ts;
  const st = state(ctx);
  const unit = ctx.frame.unit.id;
  const keyed = isRouteKeyExpr(ctx, node.expression);
  const onMethod = isMethodExpr(ctx, node.expression);
  const onPath = isPathExpr(ctx, node.expression);
  if (!keyed && !onMethod && !onPath) return;
  const outer = enclosingContext(ctx, node);
  for (const clause of node.caseBlock.clauses) {
    if (!t.isCaseClause(clause)) continue;
    const lit = ctx.stringValue(clause.expression);
    if (lit === undefined) continue;
    const body = clause.statements[0] ? clause : undefined;
    if (!body) continue;
    if (keyed) {
      const m = ROUTE_KEY_RE.exec(lit);
      if (!m) continue;
      st.dispatchers.add(unit);
      emit(ctx, clause, m[1] as string, m[2] as string, branchHandler(ctx, clause), 0.6);
    } else if (onPath && lit.startsWith("/")) {
      if (outer.methods.length > 0) {
        st.dispatchers.add(unit);
        const h = branchHandler(ctx, clause);
        for (const m of outer.methods) emit(ctx, clause, m, lit, h, 0.6);
      } else st.pending.push({ node: clause, unit, paths: [lit], handlerFrom: clause });
    } else if (onMethod && VERB_RE.test(lit) && outer.paths.length > 0) {
      st.dispatchers.add(unit);
      if (outer.pathNode) st.used.add(outer.pathNode);
      const h = branchHandler(ctx, clause);
      for (const p of outer.paths) emit(ctx, clause, lit, p, h, 0.6);
    }
  }
}

export const nodeHttpExtractor: TsExtractor = {
  id: EXTRACTOR,
  version: "1",
  framework: NODE_HTTP_FRAMEWORK,
  kinds: [
    "CallExpression",
    "ObjectLiteralExpression",
    "ArrayLiteralExpression",
    "IfStatement",
    "SwitchStatement",
  ],
  visit(node, ctx) {
    if (!enabled(ctx)) return;
    const t = ctx.ts;
    if (t.isCallExpression(node)) visitCall(ctx, node);
    else if (t.isObjectLiteralExpression(node)) visitObject(ctx, node);
    else if (t.isArrayLiteralExpression(node)) visitArray(ctx, node);
    else if (t.isIfStatement(node)) visitIf(ctx, node);
    else if (t.isSwitchStatement(node)) visitSwitch(ctx, node);
  },
  finish(ctx) {
    const st = ctx.scratch.get(EXTRACTOR) as DispatchState | undefined;
    if (!st) return;
    // Path-only branches count as routes (method ALL) only in functions that evidently dispatch.
    for (const p of st.pending) {
      if (st.used.has(p.node) || !st.dispatchers.has(p.unit)) continue;
      const saved = ctx.frame;
      const u = ctx.units_().find((x) => x.id === p.unit);
      if (u) ctx.frame = { unit: u, loop: false };
      const h = branchHandler(ctx, p.handlerFrom);
      for (const path of p.paths) emit(ctx, p.node, "ALL", path, h, 0.5);
      ctx.frame = saved;
    }
  },
};
