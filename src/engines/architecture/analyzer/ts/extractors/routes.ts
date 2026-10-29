/**
 * HTTP framework extractors: Express, Fastify, Hono, Koa (@koa/router), NestJS decorators, Next.js
 * route handlers — docs/03-engines/architecture-inspector.md §1.3. Receivers are identified by origin
 * (`express()`, `Router()`, `Fastify()`, `new Hono()`, `new Router()` from "@koa/router"), by parameter
 * type annotations (`app: Express`, `fastify: FastifyInstance`), and, as a lower-confidence fallback,
 * by conventional names (`app`, `router`, `fastify`) in files importing that framework.
 */
import type * as ts from "typescript";
import { AUTH_RE_SOURCE } from "../../../rules/auth-pattern.js";
import type { Origin, TsFileContext } from "../context.js";
import type { TsExtractor } from "../walker.js";

export const AUTH_RE = new RegExp(AUTH_RE_SOURCE, "i");
const PUBLIC_RE = /^(Public|AllowAnonymous|SkipAuth|NoAuth|Anonymous)$/;

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const FRAMEWORK_MODULES: Record<string, RegExp> = {
  express: /^express$/,
  fastify: /^fastify$/,
  hono: /^hono(\/.*)?$/,
  koa: /^(@koa\/router|koa-router|koa)$/,
  nest: /^@nestjs\//,
  next: /^next(\/.*)?$/,
};

function enabled(ctx: TsFileContext, fw: string): boolean {
  return ctx.frameworks === "auto" || ctx.frameworks.includes(fw);
}

function fileImports(ctx: TsFileContext, fw: string): boolean {
  const re = FRAMEWORK_MODULES[fw];
  return (
    !!re &&
    ctx.facts.imports.some((i) => i.external !== undefined && re.test(i.specifier.replace(/^node:/, "")))
  );
}

function routeParams(p: string): string[] {
  return [...p.matchAll(/[:{]([A-Za-z0-9_]+)\}?/g)].map((m) => m[1] as string);
}

interface Receiver {
  framework: string;
  confidence: number;
  /** Router-level prefix from `new Router({ prefix })` (koa). */
  prefix?: string;
}

function classifyOrigin(ctx: TsFileContext, o: Origin, nameHint: string | undefined): Receiver | undefined {
  const m = o.module;
  const steps = o.steps.join("");
  if (m === "express") {
    if (
      ((o.name === "default" || o.name === "*") && (steps === "()" || steps === ".Router()")) ||
      (o.name === "Router" && steps === "()")
    ) {
      return { framework: "express", confidence: 0.95 };
    }
  }
  if (m === "fastify" && steps === "()") return { framework: "fastify", confidence: 0.95 };
  if (m && FRAMEWORK_MODULES.hono?.test(m) && o.name === "Hono" && steps.startsWith("new"))
    return { framework: "hono", confidence: 0.95 };
  if ((m === "@koa/router" || m === "koa-router") && steps === "new") {
    const r: Receiver = { framework: "koa", confidence: 0.95 };
    const ne = o.nodes[0];
    if (ne && ctx.ts.isNewExpression(ne)) {
      const obj = ctx.objectLiteral(ne.arguments?.[0]);
      const pre = obj ? ctx.stringValue(ctx.objectProps(obj).props.get("prefix")) : undefined;
      if (pre) r.prefix = pre;
    }
    return r;
  }
  if (o.param || o.unknown || o.global) {
    const tn = o.typeName ?? "";
    if (/\b(Express|Application|Router)\b/.test(tn) && fileImports(ctx, "express"))
      return { framework: "express", confidence: 0.85 };
    if (/Fastify(Instance)?\b/.test(tn)) return { framework: "fastify", confidence: 0.85 };
    if (/\bHono\b/.test(tn)) return { framework: "hono", confidence: 0.85 };
    if (nameHint) {
      if (/^(fastify|server|instance|app)$/i.test(nameHint) && fileImports(ctx, "fastify"))
        return { framework: "fastify", confidence: 0.6 };
      if (/^(app|router|r|api|routes?)$/i.test(nameHint) && fileImports(ctx, "express"))
        return { framework: "express", confidence: 0.6 };
      if (/^(app|api)$/i.test(nameHint) && fileImports(ctx, "hono"))
        return { framework: "hono", confidence: 0.6 };
      if (/^(router|r)$/i.test(nameHint) && fileImports(ctx, "koa"))
        return { framework: "koa", confidence: 0.6 };
    }
  }
  return undefined;
}

function classifyReceiver(ctx: TsFileContext, recv: ts.Expression): Receiver | undefined {
  const t = ctx.ts;
  const x = ctx.skipOuter(recv);
  const hint = t.isIdentifier(x) ? x.text : undefined;
  return classifyOrigin(ctx, ctx.originOf(x), hint);
}

function registerRoute(
  ctx: TsFileContext,
  call: ts.CallExpression,
  rcv: Receiver,
  ownerExpr: ts.Expression,
  method: string,
  path: string,
  fnArgs: readonly ts.Expression[],
  extraMiddlewares: string[] = [],
): void {
  const handlerExpr = fnArgs[fnArgs.length - 1];
  const mwExprs = fnArgs.slice(0, -1);
  const middlewares = [...extraMiddlewares, ...mwExprs.map((m) => ctx.exprName(m) ?? "<inline>")];
  const fullPath = rcv.prefix ? joinPath(rcv.prefix, path) : path;
  const M = method.toUpperCase();
  let handler: string | undefined;
  if (handlerExpr) handler = ctx.unitIdOfExpression(handlerExpr, "handler", `${M} ${fullPath}`);
  const route: Parameters<TsFileContext["addRoute"]>[0] = {
    framework: rcv.framework,
    method: M,
    path: fullPath,
    owner: ctx.ownerKey(ownerExpr),
    middlewares,
    auth: middlewares.some((m) => AUTH_RE.test(m)),
    params: routeParams(fullPath),
    extractor: `framework/${rcv.framework}`,
    confidence: rcv.confidence,
  };
  if (handler) route.handler = handler;
  ctx.addRoute(route, call);
}

export function joinPath(a: string, b: string): string {
  const j = `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
  const n = j.replace(/\/{2,}/g, "/");
  return n.length > 1 ? n.replace(/\/$/, "") : n;
}

/** Express / Hono / Koa / Fastify call-style registrations. */
export const callRoutesExtractor: TsExtractor = {
  id: "framework/call-routes",
  version: "1",
  kinds: ["CallExpression"],
  visit(node, ctx) {
    const t = ctx.ts;
    const call = node as ts.CallExpression;
    const callee = call.expression;
    if (!t.isPropertyAccessExpression(callee)) return;
    const method = callee.name.text;
    const args = call.arguments;
    const isHttp = HTTP_METHODS.has(method);
    if (!isHttp && !["use", "route", "register", "addHook", "on"].includes(method)) return;

    // express: app.route("/x").get(h)
    let recvExpr = callee.expression;
    let chainedPath: string | undefined;
    if (isHttp) {
      // walk back over `.get(h).post(h)` siblings to an `.route(path)` call
      let x: ts.Expression = recvExpr;
      for (let i = 0; i < 10 && t.isCallExpression(x) && t.isPropertyAccessExpression(x.expression); i++) {
        const nm = x.expression.name.text;
        if (nm === "route") {
          chainedPath = ctx.stringValue(x.arguments[0]);
          recvExpr = x.expression.expression;
          break;
        }
        if (!HTTP_METHODS.has(nm)) break;
        x = x.expression.expression;
      }
    }
    const rcv = classifyReceiver(ctx, recvExpr);
    if (!rcv || !enabled(ctx, rcv.framework)) return;
    const fw = rcv.framework;

    if (isHttp) {
      if (chainedPath !== undefined) {
        if (args.length >= 1) registerRoute(ctx, call, rcv, recvExpr, method, chainedPath, args);
        return;
      }
      const path = ctx.stringValue(args[0]);
      if (path === undefined) return;
      if (fw === "express" && args.length < 2) return; // app.get("setting")
      if (fw === "koa" && args.length >= 3 && t.isStringLiteralLike(args[1] as ts.Expression)) {
        // koa: router.get(name, path, ...handlers)
        const p2 = ctx.stringValue(args[1]);
        if (p2 !== undefined) registerRoute(ctx, call, rcv, recvExpr, method, p2, args.slice(2));
        return;
      }
      let fnArgs = args.slice(1);
      const extra: string[] = [];
      if (fw === "fastify") {
        // fastify.get(path, [opts], handler)
        const opts = fnArgs.length >= 2 ? ctx.objectLiteral(fnArgs[0]) : undefined;
        if (opts) {
          extra.push(...hookNames(ctx, opts));
          fnArgs = fnArgs.slice(1);
        } else if (fnArgs.length === 1) {
          const only = ctx.objectLiteral(fnArgs[0]);
          if (only) {
            extra.push(...hookNames(ctx, only));
            const h = ctx.objectProps(only).props.get("handler");
            fnArgs = h ? [h] : [];
          }
        }
      }
      if (fnArgs.length === 0) return;
      registerRoute(ctx, call, rcv, recvExpr, method, path, fnArgs, extra);
      return;
    }

    if (method === "route" && fw === "fastify") {
      const obj = ctx.objectLiteral(args[0]);
      if (!obj) return;
      const { props } = ctx.objectProps(obj);
      const url = ctx.stringValue(props.get("url") ?? props.get("path"));
      const h = props.get("handler");
      if (url === undefined || !h) return;
      const mExpr = props.get("method");
      const methods: string[] = [];
      if (mExpr && t.isArrayLiteralExpression(ctx.skipOuter(mExpr))) {
        for (const el of (ctx.skipOuter(mExpr) as ts.ArrayLiteralExpression).elements) {
          const v = ctx.stringValue(el);
          if (v) methods.push(v);
        }
      } else {
        const v = ctx.stringValue(mExpr);
        if (v) methods.push(v);
      }
      for (const m of methods) registerRoute(ctx, call, rcv, recvExpr, m, url, [h], hookNames(ctx, obj));
      return;
    }

    if (method === "route" && fw === "hono" && args.length >= 2) {
      const prefix = ctx.stringValue(args[0]);
      const sub = args[1] as ts.Expression;
      const u: Parameters<TsFileContext["addUse"]>[0] = {
        framework: fw,
        owner: ctx.ownerKey(recvExpr),
        middlewares: [],
        auth: false,
        targetOwner: ctx.ownerKey(sub),
      };
      if (prefix !== undefined) u.prefix = prefix;
      ctx.addUse(u, call);
      return;
    }

    if (method === "register" && fw === "fastify") {
      const plugin = args[0];
      if (!plugin) return;
      const optsObj = ctx.objectLiteral(args[1]);
      const prefix = optsObj ? ctx.stringValue(ctx.objectProps(optsObj).props.get("prefix")) : undefined;
      const p = ctx.pos(plugin);
      const name = ctx.exprName(plugin);
      const targetUnit = ctx.unitIdOfExpression(plugin, "function", `plugin@${p.line}`);
      const u: Parameters<TsFileContext["addUse"]>[0] = {
        framework: fw,
        owner: ctx.ownerKey(recvExpr),
        middlewares: name ? [name] : [],
        auth: !!name && AUTH_RE.test(name),
      };
      if (prefix !== undefined) u.prefix = prefix;
      if (targetUnit) u.targetUnit = targetUnit;
      ctx.addUse(u, call);
      return;
    }

    if (method === "addHook" && fw === "fastify") {
      const hook = ctx.stringValue(args[0]);
      if (!hook || !/^(onRequest|preHandler|preValidation|preParsing)$/.test(hook) || !args[1]) return;
      const name = ctx.exprName(args[1] as ts.Expression) ?? "<inline>";
      ctx.addUse(
        { framework: fw, owner: ctx.ownerKey(recvExpr), middlewares: [name], auth: AUTH_RE.test(name) },
        call,
      );
      return;
    }

    if (method === "use") {
      let rest: readonly ts.Expression[] = args;
      let prefix = ctx.stringValue(args[0]);
      if (prefix !== undefined) rest = args.slice(1);
      if (prefix !== undefined && fw === "hono") prefix = prefix.replace(/\/\*$/, "");
      for (const a of rest) {
        const x = ctx.skipOuter(a);
        const name = ctx.exprName(x) ?? "<inline>";
        const u: Parameters<TsFileContext["addUse"]>[0] = {
          framework: fw,
          owner: ctx.ownerKey(recvExpr),
          middlewares: [name],
          auth: AUTH_RE.test(name),
        };
        if (prefix !== undefined) u.prefix = prefix;
        if (t.isIdentifier(x)) u.targetOwner = ctx.ownerKey(x);
        else if (t.isCallExpression(x)) {
          const target = ctx.resolveCallTarget(x);
          if (target) u.targetUnit = target;
          // koa: app.use(router.routes())
          if (t.isPropertyAccessExpression(x.expression) && x.expression.name.text === "routes")
            u.targetOwner = ctx.ownerKey(x.expression.expression);
        }
        ctx.addUse(u, call);
      }
    }
  },
};

function hookNames(ctx: TsFileContext, obj: ts.ObjectLiteralExpression): string[] {
  const out: string[] = [];
  const { props } = ctx.objectProps(obj);
  for (const k of ["onRequest", "preHandler", "preValidation", "preParsing"]) {
    const v = props.get(k);
    if (!v) continue;
    const n = ctx.exprName(v);
    if (n) out.push(...n.split(","));
  }
  return out;
}

// ----------------------------------------------------------------------------- NestJS

const NEST_METHODS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Options: "OPTIONS",
  Head: "HEAD",
  All: "ALL",
};

function decorators(ctx: TsFileContext, n: ts.Node): { name: string; args: readonly ts.Expression[] }[] {
  const t = ctx.ts;
  const ds = t.canHaveDecorators(n) ? (t.getDecorators(n) ?? []) : [];
  return ds.map((d) => {
    const e = d.expression;
    if (t.isCallExpression(e)) return { name: ctx.exprName(e.expression) ?? "", args: e.arguments };
    return { name: ctx.exprName(e) ?? "", args: [] };
  });
}

export const nestExtractor: TsExtractor = {
  id: "framework/nest",
  version: "1",
  framework: "nest",
  kinds: ["ClassDeclaration"],
  visit(node, ctx) {
    if (!enabled(ctx, "nest")) return;
    const t = ctx.ts;
    const cls = node as ts.ClassDeclaration;
    const cds = decorators(ctx, cls);
    const ctrl = cds.find((d) => d.name === "Controller");
    if (!ctrl || !fileImports(ctx, "nest")) return;
    let prefix = "";
    const a0 = ctrl.args[0];
    if (a0) {
      const obj = ctx.objectLiteral(a0);
      prefix = (obj ? ctx.stringValue(ctx.objectProps(obj).props.get("path")) : ctx.stringValue(a0)) ?? "";
    }
    const classGuards = cds
      .filter((d) => d.name === "UseGuards")
      .flatMap((d) => d.args.map((a) => ctx.exprName(a) ?? "guard"));
    const classPublic = cds.some((d) => PUBLIC_RE.test(d.name));
    ctx.addLimitation(
      "ARCH_DI_RUNTIME",
      "NestJS dependency injection is resolved from constructor parameter types; custom providers/factories are not followed",
    );
    for (const m of cls.members) {
      if (!t.isMethodDeclaration(m)) continue;
      const mds = decorators(ctx, m);
      for (const d of mds) {
        const method = NEST_METHODS[d.name];
        if (!method) continue;
        const sub = d.args[0] ? (ctx.stringValue(d.args[0]) ?? "") : "";
        const path = joinPath(`/${prefix}`, sub);
        const guards = [
          ...classGuards,
          ...mds
            .filter((x) => x.name === "UseGuards")
            .flatMap((x) => x.args.map((a) => ctx.exprName(a) ?? "guard")),
        ];
        const isPublic = classPublic || mds.some((x) => PUBLIC_RE.test(x.name));
        const route: Parameters<TsFileContext["addRoute"]>[0] = {
          framework: "nest",
          method,
          path,
          owner: `${ctx.file}#${cls.name?.text ?? "<anonymous>"}`,
          middlewares: guards,
          auth: guards.length > 0,
          params: routeParams(path),
          extractor: "framework/nest",
          confidence: 0.9,
        };
        if (isPublic) route.public = true;
        const h = ctx.unitIdFor(m);
        if (h) route.handler = h;
        ctx.addRoute(route, m);
      }
    }
  },
};

// ----------------------------------------------------------------------------- Next.js

const NEXT_APP_RE = /(^|\/)app\/(.*\/)?route\.(t|j)sx?$/;
const NEXT_PAGES_RE = /(^|\/)pages\/(api\/.+)\.(t|j)sx?$/;

function nextPath(file: string): string | undefined {
  let m = NEXT_APP_RE.exec(file);
  let raw: string | undefined;
  if (m) raw = `/${m[2] ?? ""}`;
  else {
    m = NEXT_PAGES_RE.exec(file);
    if (m) raw = `/${(m[2] as string).replace(/\/index$/, "")}`;
  }
  if (raw === undefined) return undefined;
  const segs = raw
    .split("/")
    .filter((s) => s !== "" && !/^\(.*\)$/.test(s) && !s.startsWith("@"))
    .map((s) => s.replace(/^\[\[?\.\.\.(.+?)\]\]?$/, "*").replace(/^\[(.+)\]$/, ":$1"));
  return `/${segs.join("/")}`;
}

export const nextExtractor: TsExtractor = {
  id: "framework/next",
  version: "1",
  framework: "next",
  kinds: ["FunctionDeclaration", "VariableStatement", "ExportAssignment"],
  visit(node, ctx) {
    if (!enabled(ctx, "next")) return;
    const t = ctx.ts;
    if (node.parent !== ctx.sf) return;
    const path = nextPath(ctx.file);
    if (path === undefined) return;
    const isApp = NEXT_APP_RE.test(ctx.file);
    const exported = (n: ts.Node) =>
      !!(n as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers?.some(
        (m) => m.kind === t.SyntaxKind.ExportKeyword,
      );
    const isDefault = (n: ts.Node) =>
      !!(n as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers?.some(
        (m) => m.kind === t.SyntaxKind.DefaultKeyword,
      );
    const emit = (method: string, fn: ts.Node, at: ts.Node) => {
      const r: Parameters<TsFileContext["addRoute"]>[0] = {
        framework: "next",
        method,
        path,
        owner: `${ctx.file}#<module>:next`,
        middlewares: [],
        auth: false,
        params: routeParams(path),
        extractor: "framework/next",
        confidence: 0.85,
      };
      const h = ctx.unitIdFor(fn);
      if (h) r.handler = h;
      ctx.addRoute(r, at);
    };
    if (t.isFunctionDeclaration(node) && exported(node) && node.name) {
      if (isApp && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(node.name.text))
        emit(node.name.text, node, node);
      else if (!isApp && isDefault(node)) emit("ALL", node, node);
    } else if (t.isVariableStatement(node) && exported(node) && isApp) {
      for (const d of node.declarationList.declarations) {
        if (
          t.isIdentifier(d.name) &&
          /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(d.name.text) &&
          d.initializer &&
          ctx.isFunctionLike(ctx.skipOuter(d.initializer))
        ) {
          emit(d.name.text, ctx.skipOuter(d.initializer), d);
        }
      }
    } else if (t.isExportAssignment(node) && !isApp) {
      const fn =
        ctx.resolveFunctionDecl(node.expression) ??
        (ctx.isFunctionLike(ctx.skipOuter(node.expression)) ? ctx.skipOuter(node.expression) : undefined);
      if (fn) {
        const id = ctx.unitIdOfExpression(node.expression, "handler", `ALL ${path}`);
        const r: Parameters<TsFileContext["addRoute"]>[0] = {
          framework: "next",
          method: "ALL",
          path,
          owner: `${ctx.file}#<module>:next`,
          middlewares: [],
          auth: false,
          params: routeParams(path),
          extractor: "framework/next",
          confidence: 0.85,
        };
        if (id) r.handler = id;
        ctx.addRoute(r, node);
      }
    }
  },
};
