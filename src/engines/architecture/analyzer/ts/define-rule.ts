/**
 * ESLint-like AST rule authoring for plugins — docs/10-plugins-and-extensibility.md §4.
 *   const r = defineTsRule({ meta: ruleMeta("acme/no-x", ...), create: (api) => ({ CallExpression(node) { … api.report({ node, message }) } }) });
 *   inspectArchitecture(input, ctx, { extractors: [r.extractor], rules: [r.rule] });
 * The visitor runs inside the TS adapter (kind-indexed dispatch); reports become cached RuleHits that
 * the generic rule layer turns into findings (levels, suppression, fingerprints).
 */
import type * as ts from "typescript";
import { type ArchRule, hitRule, type RuleMeta } from "../../rules/index.js";
import type { Origin, SyntaxKindName, TsFileContext } from "./context.js";
import type { TsExtractor } from "./walker.js";

export interface TsRuleApi {
  ctx: TsFileContext;
  ts: typeof import("typescript");
  report(r: { node: ts.Node; message: string; confidence?: number; requiresHandler?: boolean }): void;
  /** Static origin of an expression (module/import/steps), lazily via the TypeChecker. */
  originOf(e: ts.Expression): Origin;
  /** True when an object-literal argument has the property. */
  hasArgProperty(call: ts.CallExpression, prop: string): boolean;
}

export interface TsRuleDefinition {
  meta: RuleMeta;
  version?: string;
  create(api: TsRuleApi): Partial<Record<SyntaxKindName, (node: ts.Node) => void>>;
}

export function defineTsRule(def: TsRuleDefinition): { extractor: TsExtractor; rule: ArchRule } {
  // Visitors are created per file (fresh api/ctx); kinds are collected from a probe.
  const probe = def.create({} as TsRuleApi);
  const kinds = Object.keys(probe) as SyntaxKindName[];
  const perCtx = new WeakMap<TsFileContext, Partial<Record<SyntaxKindName, (node: ts.Node) => void>>>();
  const extractor: TsExtractor = {
    id: `rule/${def.meta.id}`,
    version: def.version ?? "1",
    kinds,
    visit(node, ctx) {
      let v = perCtx.get(ctx);
      if (!v) {
        const api: TsRuleApi = {
          ctx,
          ts: ctx.ts,
          report: ({ node: n, message, confidence, requiresHandler }) =>
            ctx.addHit(
              {
                ruleId: def.meta.id,
                message,
                confidence: confidence ?? 0.7,
                ...(requiresHandler ? { requiresHandler } : {}),
              },
              n,
            ),
          originOf: (e) => ctx.originOf(e),
          hasArgProperty: (call, prop) =>
            call.arguments.some((a) => {
              const o = ctx.objectLiteral(a);
              return !!o && ctx.objectProps(o).props.has(prop);
            }),
        };
        v = def.create(api);
        perCtx.set(ctx, v);
      }
      for (const k of kinds) if ((ctx.ts.SyntaxKind[k] as number) === node.kind) v[k]?.(node);
    },
  };
  return { extractor, rule: hitRule(def.meta) };
}
