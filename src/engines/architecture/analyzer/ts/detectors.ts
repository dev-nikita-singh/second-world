/**
 * AST-level rule detectors (TypeScript adapter) — docs/03-engines/architecture-inspector.md §4.
 * They emit raw `RuleHit`s (cached with the file's facts); the language-agnostic rule layer applies
 * configuration, handler reachability, suppressions and fingerprints.
 *   ARCH002 retry loops without max attempts / backoff / jitter, and `retries: Infinity` configs
 *   ARCH004 synchronous heavy work (`fs.*Sync`, `crypto.*Sync`, `child_process.*Sync`, `zlib.*Sync`, JSON.parse(body))
 *   ARCH009 module-level Map/Set/array that only grows
 *   ARCH010 hard-coded secrets (provider patterns + entropy near key-like names)
 *   ARCH011 floating promise (call returning a thenable, not awaited/returned/voided/caught)
 */
import type * as ts from "typescript";
import { sha256 } from "../../../../shared/index.js";
import type { TsFileContext } from "./context.js";
import type { TsExtractor } from "./walker.js";

/** Iterative bounded subtree scan (includes nested functions). */
function* descendants(ctx: TsFileContext, root: ts.Node, limit = 20_000): Generator<ts.Node> {
  const stack: ts.Node[] = [root];
  let n = 0;
  while (stack.length > 0 && n++ < limit) {
    const x = stack.pop() as ts.Node;
    yield x;
    ctx.ts.forEachChild(x, (c) => {
      stack.push(c);
    });
  }
}

const ATTEMPT_RE = /attempt|retr(y|ies)|tries|tried|max_?attempts/i;
const SLEEP_RE = /^(setTimeout|sleep|delay|wait|backoff|pause|waitFor)$/i;
const DYNAMIC_DELAY_RE = /random|jitter|\*\*|Math\.pow|<<|backoff|rng|exponential|\*/i;

function isConstTrue(ctx: TsFileContext, e: ts.Expression | undefined): boolean {
  if (!e) return true;
  const x = ctx.skipOuter(e);
  if (x.kind === ctx.ts.SyntaxKind.TrueKeyword) return true;
  return ctx.ts.isNumericLiteral(x) && Number(x.text) !== 0;
}

function calleeName(ctx: TsFileContext, call: ts.CallExpression): string | undefined {
  const t = ctx.ts;
  const c = ctx.skipOuter(call.expression);
  if (t.isIdentifier(c)) return c.text;
  if (t.isPropertyAccessExpression(c)) return c.name.text;
  return undefined;
}

function checkRetryLoop(ctx: TsFileContext, loop: ts.IterationStatement): void {
  const t = ctx.ts;
  let infinite = false;
  let cond: ts.Expression | undefined;
  if (t.isWhileStatement(loop) || t.isDoStatement(loop)) {
    cond = loop.expression;
    infinite = isConstTrue(ctx, cond);
  } else if (t.isForStatement(loop)) {
    cond = loop.condition;
    infinite = cond === undefined || isConstTrue(ctx, cond);
  } else return;

  let hasTryWithCall = false;
  let attemptHint = false;
  let boundedByIf = false;
  const sleeps: ts.CallExpression[] = [];
  for (const n of descendants(ctx, loop)) {
    if (t.isTryStatement(n) && !hasTryWithCall) {
      for (const d of descendants(ctx, n.tryBlock, 5000)) {
        if (t.isCallExpression(d)) {
          hasTryWithCall = true;
          break;
        }
      }
    } else if (t.isIdentifier(n) && ATTEMPT_RE.test(n.text)) attemptHint = true;
    else if (t.isCallExpression(n)) {
      const nm = calleeName(ctx, n);
      if (nm && SLEEP_RE.test(nm)) sleeps.push(n);
    } else if (t.isIfStatement(n) && !boundedByIf) {
      const condText = n.expression.getText(ctx.sf);
      if (
        /[<>]=?|===?/.test(condText) &&
        (ATTEMPT_RE.test(condText) || /\bMAX|max[A-Z]|limit/i.test(condText))
      ) {
        for (const d of descendants(ctx, n.thenStatement, 2000)) {
          if (t.isBreakStatement(d) || t.isThrowStatement(d) || t.isReturnStatement(d)) {
            boundedByIf = true;
            break;
          }
        }
      }
    }
  }
  if (!hasTryWithCall || !(infinite || attemptHint)) return;
  const bounded = !infinite || boundedByIf;
  if (!bounded) {
    ctx.addHit(
      {
        ruleId: "ARCH002",
        message: `Retry loop has no maximum number of attempts${sleeps.length === 0 ? " and no backoff between attempts" : ""}`,
        confidence: 0.8,
        severity: "high",
        data: { bounded: false, backoff: sleeps.length > 0 },
        snippet: loop.getText(ctx.sf).split("\n")[0]?.trim() ?? "",
      },
      loop.getChildAt(0, ctx.sf),
    );
    return;
  }
  if (sleeps.length === 0) {
    ctx.addHit(
      {
        ruleId: "ARCH002",
        message: "Retry loop retries immediately (no backoff between attempts)",
        confidence: 0.7,
        severity: "high",
        data: { bounded: true, backoff: false },
        snippet: loop.getText(ctx.sf).split("\n")[0]?.trim() ?? "",
      },
      loop.getChildAt(0, ctx.sf),
    );
    return;
  }
  const s = sleeps[0] as ts.CallExpression;
  const nm = calleeName(ctx, s) ?? "";
  const delayArg = /^setTimeout$/i.test(nm) ? s.arguments[1] : s.arguments[0];
  const dynamic = delayArg ? DYNAMIC_DELAY_RE.test(delayArg.getText(ctx.sf)) : false;
  if (!dynamic) {
    ctx.addHit(
      {
        ruleId: "ARCH002",
        message:
          "Retry loop waits a fixed delay: no exponential backoff and no jitter (clients retry in lock-step)",
        confidence: 0.6,
        severity: "medium",
        data: { bounded: true, backoff: true, jitter: false },
      },
      s,
    );
  }
}

const SYNC_MODULES = new Set(["fs", "crypto", "child_process", "zlib"]);
const CHEAP_SYNC = /^(existsSync|statSync|lstatSync|accessSync|realpathSync|mkdirSync)$/;

export const detectorsExtractor: TsExtractor = {
  id: "rules/ts-detectors",
  version: "1",
  kinds: [
    "WhileStatement",
    "DoStatement",
    "ForStatement",
    "PropertyAssignment",
    "CallExpression",
    "StringLiteral",
    "NoSubstitutionTemplateLiteral",
    "ExpressionStatement",
    "VariableStatement",
  ],
  visit(node, ctx) {
    const t = ctx.ts;
    switch (node.kind) {
      case t.SyntaxKind.WhileStatement:
      case t.SyntaxKind.DoStatement:
      case t.SyntaxKind.ForStatement:
        checkRetryLoop(ctx, node as ts.IterationStatement);
        return;
      case t.SyntaxKind.PropertyAssignment:
        checkRetryConfig(ctx, node as ts.PropertyAssignment);
        checkSecret(ctx, (node as ts.PropertyAssignment).initializer);
        return;
      case t.SyntaxKind.CallExpression:
        checkSyncCall(ctx, node as ts.CallExpression);
        trackGrowth(ctx, node as ts.CallExpression);
        return;
      case t.SyntaxKind.StringLiteral:
      case t.SyntaxKind.NoSubstitutionTemplateLiteral:
        if (!t.isPropertyAssignment(node.parent)) checkSecret(ctx, node as ts.StringLiteral);
        return;
      case t.SyntaxKind.ExpressionStatement:
        checkFloating(ctx, node as ts.ExpressionStatement);
        return;
      case t.SyntaxKind.VariableStatement:
        if (node.parent === ctx.sf) trackModuleCollections(ctx, node as ts.VariableStatement);
        return;
    }
  },
  finish(ctx) {
    const st = ctx.scratch.get("growth") as GrowthState | undefined;
    if (!st) return;
    for (const [name, c] of st.candidates) {
      const g = st.grows.get(name) ?? 0;
      if (g > 0 && !st.bounded.has(name)) {
        ctx.addHit(
          {
            ruleId: "ARCH009",
            message: `Module-level ${c.kind} "${name}" grows (${g} insertion site(s)) but is never evicted or size-bounded`,
            confidence: 0.6,
            data: { name, kind: c.kind },
          },
          c.node,
        );
      }
    }
  },
};

function checkRetryConfig(ctx: TsFileContext, p: ts.PropertyAssignment): void {
  const t = ctx.ts;
  const name = p.name.getText(ctx.sf).replace(/['"]/g, "");
  if (!/^(retries|maxRetries|retry|retryCount|maxAttempts|attempts|retryLimit)$/.test(name)) return;
  const v = p.initializer.getText(ctx.sf).replace(/\s+/g, "");
  if (/^(Infinity|-1|Number\.(POSITIVE_INFINITY|MAX_SAFE_INTEGER|MAX_VALUE))$/.test(v)) {
    ctx.addHit(
      {
        ruleId: "ARCH002",
        message: `Retry configuration "${name}: ${v}" is unbounded`,
        confidence: 0.75,
        severity: "high",
        data: { config: true },
      },
      p,
    );
  }
  void t;
}

function checkSyncCall(ctx: TsFileContext, call: ts.CallExpression): void {
  const t = ctx.ts;
  const callee = ctx.skipOuter(call.expression);
  if (!t.isIdentifier(callee) && !t.isPropertyAccessExpression(callee)) return;
  const nm = t.isIdentifier(callee) ? callee.text : callee.name.text;
  if (
    nm === "parse" &&
    t.isPropertyAccessExpression(callee) &&
    t.isIdentifier(callee.expression) &&
    callee.expression.text === "JSON"
  ) {
    const a = call.arguments[0];
    if (a && /\b(req|request|ctx)\.(body|rawBody|request\.body)|\brawBody\b/.test(a.getText(ctx.sf))) {
      ctx.addHit(
        {
          ruleId: "ARCH004",
          message: "JSON.parse on an unbounded request body blocks the event loop for large inputs",
          confidence: 0.4,
          severity: "low",
          requiresHandler: true,
          data: { callee: "JSON.parse" },
        },
        call,
      );
    }
    return;
  }
  if (!nm.endsWith("Sync")) return;
  const o = ctx.originOf(callee);
  if (!o.module || !SYNC_MODULES.has(o.module)) return;
  const fn = o.steps.length === 0 ? o.name : (o.steps[o.steps.length - 1] ?? "").replace(/^\./, "");
  if (!fn?.endsWith("Sync") || o.steps.length > 1) return;
  const cheap = CHEAP_SYNC.test(fn);
  ctx.addHit(
    {
      ruleId: "ARCH004",
      message: `Synchronous ${o.module}.${fn} blocks the event loop while handling requests`,
      confidence: cheap ? 0.5 : 0.85,
      severity: cheap ? "low" : "medium",
      requiresHandler: true,
      data: { callee: fn, module: o.module },
    },
    call,
  );
}

// ---------------------------------------------------------------- ARCH009 growth tracking

interface GrowthState {
  candidates: Map<string, { kind: string; node: ts.Node }>;
  grows: Map<string, number>;
  bounded: Set<string>;
}

function growthState(ctx: TsFileContext): GrowthState {
  let st = ctx.scratch.get("growth") as GrowthState | undefined;
  if (!st) {
    st = { candidates: new Map(), grows: new Map(), bounded: new Set() };
    ctx.scratch.set("growth", st);
  }
  return st;
}

function trackModuleCollections(ctx: TsFileContext, vs: ts.VariableStatement): void {
  const t = ctx.ts;
  for (const d of vs.declarationList.declarations) {
    if (!t.isIdentifier(d.name) || !d.initializer) continue;
    const init = ctx.skipOuter(d.initializer);
    let kind: string | undefined;
    if (
      t.isNewExpression(init) &&
      t.isIdentifier(init.expression) &&
      (init.expression.text === "Map" || init.expression.text === "Set")
    ) {
      if ((init.arguments?.length ?? 0) === 0) kind = init.expression.text;
    } else if (t.isArrayLiteralExpression(init) && init.elements.length === 0) kind = "array";
    if (kind) growthState(ctx).candidates.set(d.name.text, { kind, node: d });
  }
}

function trackGrowth(ctx: TsFileContext, call: ts.CallExpression): void {
  const t = ctx.ts;
  const c = call.expression;
  if (!t.isPropertyAccessExpression(c) || !t.isIdentifier(c.expression)) return;
  const st = ctx.scratch.get("growth") as GrowthState | undefined;
  const name = c.expression.text;
  const m = c.name.text;
  const s = st ?? growthState(ctx);
  if (/^(set|add|push|unshift)$/.test(m)) {
    if (ctx.frame.unit.kind !== "module-init") s.grows.set(name, (s.grows.get(name) ?? 0) + 1);
  } else if (/^(delete|clear|shift|splice|pop)$/.test(m)) s.bounded.add(name);
}

/** `.size`/`.length` comparisons or `x.length = n` count as a bound — scanned lazily in finish via text. */
export const growthBoundExtractor: TsExtractor = {
  id: "rules/ts-growth-bound",
  version: "1",
  kinds: ["PropertyAccessExpression"],
  visit(node, ctx) {
    const t = ctx.ts;
    const pa = node as ts.PropertyAccessExpression;
    if (!t.isIdentifier(pa.expression) || (pa.name.text !== "size" && pa.name.text !== "length")) return;
    const p = pa.parent;
    if (t.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      const S = t.SyntaxKind;
      if (
        [
          S.GreaterThanToken,
          S.GreaterThanEqualsToken,
          S.LessThanToken,
          S.LessThanEqualsToken,
          S.EqualsEqualsEqualsToken,
          S.EqualsToken,
        ].includes(k)
      ) {
        growthState(ctx).bounded.add(pa.expression.text);
      }
    }
  },
};

// ---------------------------------------------------------------- ARCH010 secrets

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS access key id", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "private key block", re: /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Stripe live key", re: /\b(sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "Anthropic/OpenAI-style API key", re: /\bsk-(ant-)?[A-Za-z0-9_-]{32,}\b/ },
];
const CONN_STRING = /\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:([^@\s/]{3,})@/i;
const SECRET_NAME =
  /(secret|passw(or)?d|\bpwd\b|pwd$|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?key|credential|signing[_-]?key)/i;
const NOT_SECRET_NAME =
  /(header|name|url|uri|endpoint|path|type|field|prefix|env|var|label|placeholder|regex|pattern|format|kind|mode|length|ttl|expires?|count|id)$/i;
const PLACEHOLDER =
  /^(x+|\*+|\.+|changeme|change-me|your[-_ ].*|example.*|dummy.*|test.*|fake.*|<.*>|\$\{.*\}|todo|redacted|password|secret|token)$/i;

export function shannonEntropyBits(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function contextName(ctx: TsFileContext, lit: ts.Node): string | undefined {
  const t = ctx.ts;
  const p = lit.parent;
  if (!p) return undefined;
  if (t.isVariableDeclaration(p) && p.initializer === lit) return p.name.getText(ctx.sf);
  if (t.isPropertyAssignment(p) && p.initializer === lit) return p.name.getText(ctx.sf).replace(/['"]/g, "");
  if (t.isPropertyDeclaration(p) && p.initializer === lit) return p.name.getText(ctx.sf);
  if (t.isParameter(p) && p.initializer === lit) return p.name.getText(ctx.sf);
  if (t.isBinaryExpression(p) && p.right === lit && p.operatorToken.kind === t.SyntaxKind.EqualsToken) {
    const l = p.left.getText(ctx.sf);
    return l
      .split(/[.[\]'"]/)
      .filter(Boolean)
      .pop();
  }
  return undefined;
}

function checkSecret(ctx: TsFileContext, e: ts.Expression): void {
  const t = ctx.ts;
  if (!t.isStringLiteral(e) && !t.isNoSubstitutionTemplateLiteral(e)) return;
  const p = e.parent;
  if (
    p &&
    (t.isImportDeclaration(p) ||
      t.isExportDeclaration(p) ||
      t.isExternalModuleReference(p) ||
      t.isLiteralTypeNode(p))
  )
    return;
  const v = e.text;
  if (v.length < 12) return;
  const isTestFile = /(\.|\/)(test|spec)\.|__tests__|\/fixtures?\//.test(ctx.file);
  const name = contextName(ctx, e);
  let kind: string | undefined;
  for (const sp of SECRET_PATTERNS) {
    if (sp.re.test(v)) {
      kind = sp.name;
      break;
    }
  }
  if (!kind) {
    const cm = CONN_STRING.exec(v);
    if (cm && !PLACEHOLDER.test(cm[1] as string) && !(cm[1] as string).includes("${"))
      kind = "credentials in connection string";
  }
  if (
    !kind &&
    name &&
    SECRET_NAME.test(name) &&
    !NOT_SECRET_NAME.test(name) &&
    !/\s/.test(v) &&
    !PLACEHOLDER.test(v)
  ) {
    const h = shannonEntropyBits(v);
    if (
      (v.length >= 20 && h > 4.0) ||
      (v.length >= 16 && h >= 3.5) ||
      (/^[0-9a-f]{32,}$/i.test(v) && h >= 3.0)
    )
      kind = "high-entropy value in a secret-like variable";
  }
  if (!kind) return;
  const digest = sha256(v).slice(0, 12);
  ctx.addHit(
    {
      ruleId: "ARCH010",
      message: `Hard-coded secret (${kind})${name ? ` in "${name}"` : ""}`,
      confidence: isTestFile ? 0.4 : kind.startsWith("high-entropy") ? 0.6 : 0.85,
      // never put the secret itself into snippets/messages
      snippet: `${name ?? "<literal>"}=<secret:${digest}>`,
      data: { kind },
    },
    e,
  );
}

// ---------------------------------------------------------------- ARCH011 floating promises

function checkFloating(ctx: TsFileContext, st: ts.ExpressionStatement): void {
  const t = ctx.ts;
  if (ctx.frame.unit.kind === "module-init") return;
  const e = st.expression;
  let x = e;
  while (t.isParenthesizedExpression(x)) x = x.expression;
  if (!t.isCallExpression(x)) return;
  const c = x.expression;
  if (t.isPropertyAccessExpression(c)) {
    const m = c.name.text;
    if (m === "catch" || m === "finally" || (m === "then" && x.arguments.length >= 2)) return;
  }
  let type: ts.Type;
  try {
    type = ctx.checker.getTypeAtLocation(x);
  } catch {
    return;
  }
  if (type.flags & (t.TypeFlags.Any | t.TypeFlags.Unknown | t.TypeFlags.Void | t.TypeFlags.Undefined)) return;
  const parts = type.isUnion() ? type.types : [type];
  const thenable = parts.some((p) => {
    const sym = p.getSymbol();
    if (sym && /^(FastifyReply)$/.test(sym.getName())) return false;
    return !!ctx.checker.getPropertyOfType(p, "then");
  });
  if (!thenable) return;
  ctx.addHit(
    {
      ruleId: "ARCH011",
      message:
        "Promise is neither awaited, returned, voided nor caught (floating promise): errors become unhandled rejections and ordering is lost",
      confidence: 0.75,
      requiresHandler: true,
    },
    x,
  );
}
