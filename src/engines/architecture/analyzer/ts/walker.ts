/**
 * Iterative AST visitor with kind-indexed dispatch — docs/04-data-structures-and-algorithms.md §5.10.
 * Explicit stack (no recursion), O(nodes) regardless of extractor count: a dispatch table (array indexed
 * by SyntaxKind) calls only the extractors interested in a kind. Tracks the enclosing unit and whether
 * a node executes once per loop iteration.
 */
import type * as ts from "typescript";
import type { Frame, SyntaxKindName, TsFileContext, TsModule } from "./context.js";

/** Plugin interface (docs/10-plugins-and-extensibility.md §2): `kinds` + `visit(node, ctx)` → facts. */
export interface TsExtractor {
  readonly id: string;
  readonly version: string;
  /** Framework id this extractor belongs to (disabled when `frameworks` excludes it). */
  readonly framework?: string;
  readonly kinds: readonly SyntaxKindName[];
  visit(node: ts.Node, ctx: TsFileContext): void;
  /** Called once per file after the walk. */
  finish?(ctx: TsFileContext): void;
}

export type VisitFn = (node: ts.Node, ctx: TsFileContext) => void;

export function buildDispatch(t: TsModule, extractors: readonly TsExtractor[]): (VisitFn[] | undefined)[] {
  const table: (VisitFn[] | undefined)[] = [];
  for (const ex of extractors) {
    for (const k of ex.kinds) {
      const kind = t.SyntaxKind[k] as number;
      let list = table[kind];
      if (!list) {
        list = [];
        table[kind] = list;
      }
      list.push((n, c) => ex.visit(n, c));
    }
  }
  return table;
}

interface Item {
  node: ts.Node;
  frame: Frame;
}

export function walkFile(
  ctx: TsFileContext,
  dispatch: readonly (VisitFn[] | undefined)[],
  signal?: AbortSignal,
): void {
  const t = ctx.ts;
  const K = t.SyntaxKind;
  const stack: Item[] = [{ node: ctx.sf, frame: ctx.frame }];
  const children: ts.Node[] = [];
  let n = 0;
  while (stack.length > 0) {
    if ((++n & 4095) === 0 && signal?.aborted) return;
    const { node, frame } = stack.pop() as Item;
    ctx.frame = frame;
    const fns = dispatch[node.kind];
    if (fns) for (const fn of fns) fn(node, ctx);

    let childFrame = frame;
    if (ctx.isFunctionLike(node)) childFrame = ctx.enterFunction(node, frame);

    children.length = 0;
    t.forEachChild(node, (c) => {
      children.push(c);
    });
    // Loop bodies (and repeated parts) run once per iteration.
    let loopParts: Set<ts.Node> | undefined;
    switch (node.kind) {
      case K.ForOfStatement:
      case K.ForInStatement:
        loopParts = new Set([(node as ts.ForOfStatement).statement]);
        break;
      case K.ForStatement: {
        const f = node as ts.ForStatement;
        loopParts = new Set(
          [f.statement, f.condition, f.incrementor].filter((x): x is NonNullable<typeof x> => !!x),
        );
        break;
      }
      case K.WhileStatement:
      case K.DoStatement:
        loopParts = new Set(children);
        break;
    }
    const loopFrame = loopParts ? { unit: childFrame.unit, loop: true } : childFrame;
    for (let i = children.length - 1; i >= 0; i--) {
      const c = children[i] as ts.Node;
      stack.push({ node: c, frame: loopParts?.has(c) ? loopFrame : childFrame });
    }
  }
  ctx.frame = { unit: ctx.moduleUnit, loop: false };
}
