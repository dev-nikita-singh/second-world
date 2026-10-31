/**
 * Property tests for graph algorithms (src/shared/graph/*; docs/04 §2) and IPOG pairwise
 * generation with constraints (src/engines/bugs/algorithms/ipog.ts; docs/04 §7.3).
 * Owner: sw-coverage (Wave 5).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ipog, uncoveredPairs } from "../../../src/engines/bugs/algorithms/ipog.js";
import { findCycles, shortestCycle } from "../../../src/shared/graph/cycles.js";
import { DiGraph } from "../../../src/shared/graph/digraph.js";
import { condensation, cyclicSccs, tarjanScc } from "../../../src/shared/graph/scc.js";
import { CycleError, isDag, topoLevels, topoSort } from "../../../src/shared/graph/toposort.js";
import { bfs, dfs, enumeratePaths, reachable, shortestPath } from "../../../src/shared/graph/traverse.js";

const node = fc.integer({ min: 0, max: 9 }).map((i) => `n${i}`);
const edges = fc.array(fc.tuple(node, node), { maxLength: 30 });
function build(es: [string, string][], extra: string[] = []): DiGraph {
  const g = new DiGraph();
  for (const n of extra) g.addNode(n);
  for (const [a, b] of es) g.addEdge(a, b);
  return g;
}
/** DAG: only edges from lower to higher index. */
const dagEdges = edges.map((es) => es.filter(([a, b]) => a < b));

describe("DiGraph structure", () => {
  it("property: reverse twice is identity; CSR mirrors adjacency; removeNode drops incident edges", () => {
    fc.assert(
      fc.property(edges, node, (es, victim) => {
        const g = build(es);
        const rr = g.reverse().reverse();
        expect(
          rr
            .edges()
            .map((e) => `${e.from}>${e.to}`)
            .sort(),
        ).toEqual(
          g
            .edges()
            .map((e) => `${e.from}>${e.to}`)
            .sort(),
        );
        const csr = g.toCsr();
        for (let i = 0; i < csr.ids.length; i++) {
          const outs = Array.from(
            csr.targets.slice(csr.offsets[i], csr.offsets[i + 1]),
            (t) => csr.ids[t],
          ).sort();
          expect(outs).toEqual(g.successors(csr.ids[i] as string).sort());
          expect(csr.rOffsets[i + 1]! - csr.rOffsets[i]!).toBe(g.inDegree(csr.ids[i] as string));
        }
        const had = g.hasNode(victim);
        expect(g.removeNode(victim)).toBe(had);
        expect(g.edges().some((e) => e.from === victim || e.to === victim)).toBe(false);
        expect(g.edgeCount).toBe(g.edges().length);
      }),
    );
  });

  it("edge data, removal, subgraph and degrees of missing nodes", () => {
    const g = new DiGraph<string, number>();
    g.addEdge("a", "b", 1).addEdge("a", "b", 2).addEdge("b", "c");
    g.addNode("a", "A");
    g.addNode("a");
    expect(g.nodeData("a")).toBe("A");
    expect(g.edgeData("a", "b")).toEqual([1, 2]);
    expect(g.edgeData("x", "y")).toEqual([]);
    expect(g.outDegree("zz")).toBe(0);
    expect(g.inDegree("zz")).toBe(0);
    expect(g.successors("zz")).toEqual([]);
    expect(g.predecessors("zz")).toEqual([]);
    expect(g.removeEdge("a", "c")).toBe(false);
    expect(g.removeNode("zz")).toBe(false);
    const s = g.subgraph(["a", "b", "nope"]);
    expect(s.nodes().sort()).toEqual(["a", "b"]);
    expect(s.edgeData("a", "b")).toEqual([1, 2]);
    expect(g.reverse().edgeData("b", "a")).toEqual([1, 2]);
    expect(g.removeEdge("a", "b")).toBe(true);
    expect(g.hasEdge("a", "b")).toBe(false);
  });
});

describe("topological order and SCCs", () => {
  it("property: topoSort of a DAG respects every edge; levels partition the nodes", () => {
    fc.assert(
      fc.property(dagEdges, (es) => {
        const g = build(es);
        expect(isDag(g)).toBe(true);
        const order = topoSort(g);
        const pos = new Map(order.map((n, i) => [n, i]));
        for (const [a, b] of es) expect(pos.get(a)!).toBeLessThan(pos.get(b)!);
        const levels = topoLevels(g);
        expect(levels.flat().sort()).toEqual(g.nodes().sort());
      }),
    );
  });

  it("property: SCCs partition the nodes; a graph is a DAG iff no cyclic SCC; condensation is acyclic", () => {
    fc.assert(
      fc.property(edges, (es) => {
        const g = build(es);
        const sccs = tarjanScc(g);
        expect(sccs.flat().sort()).toEqual(g.nodes().sort());
        const cyclic = cyclicSccs(g);
        expect(isDag(g)).toBe(cyclic.length === 0);
        const c = condensation(g);
        expect(isDag(c.dag as DiGraph)).toBe(true);
        if (cyclic.length > 0) {
          expect(() => topoSort(g)).toThrow(CycleError);
          const cyc = shortestCycle(g);
          expect(cyc).not.toBeNull();
          // consecutive nodes of the cycle are edges, and it closes
          const c2 = cyc as string[];
          for (let i = 0; i < c2.length; i++)
            expect(g.hasEdge(c2[i] as string, c2[(i + 1) % c2.length] as string)).toBe(true);
          expect(findCycles(g).length).toBeGreaterThan(0);
        } else {
          expect(shortestCycle(g)).toBeNull();
        }
      }),
    );
  });

  it("self loops and bounded source search", () => {
    const g = build([
      ["a", "a"],
      ["b", "c"],
      ["c", "b"],
    ]);
    expect(shortestCycle(g)).toEqual(["a"]);
    expect(shortestCycle(g, ["b", "c"], { maxSources: 1 })?.length).toBe(2);
    expect(
      shortestCycle(
        build([
          ["b", "c"],
          ["c", "b"],
        ]),
        undefined,
        { maxSources: 0 },
      ),
    ).toBeNull();
  });
});

describe("traversal", () => {
  it("property: BFS shortest paths are valid and no longer than any enumerated path", () => {
    fc.assert(
      fc.property(edges, node, node, (es, s, t) => {
        const g = build(es, [s, t]);
        const sp = shortestPath(g, s, t);
        const all = enumeratePaths(g, s, t, { maxPaths: 50, maxDepth: 12 });
        const reach = reachable(g, s);
        if (sp) {
          expect(sp[0]).toBe(s);
          expect(sp.at(-1)).toBe(t);
          for (let i = 0; i + 1 < sp.length; i++) expect(g.hasEdge(sp[i]!, sp[i + 1]!)).toBe(true);
          for (const p of all) expect(sp.length).toBeLessThanOrEqual(p.length);
          expect(reach.has(t) || s === t).toBe(true);
        } else {
          expect(all).toEqual([]);
        }
        for (const p of all) expect(new Set(p).size).toBe(p.length); // simple paths
      }),
    );
  });

  it("bfs/dfs options and bounds", () => {
    const g = build([
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["a", "c"],
    ]);
    expect(bfs(g, ["a"], { maxDepth: 1 }).order.sort()).toEqual(["a", "b", "c"]);
    expect(bfs(g, "d", { reverse: true } as never).order.length).toBeGreaterThan(1);
    expect(dfs(g, "a").preorder[0]).toBe("a");
    expect(enumeratePaths(g, "a", "a")).toEqual([["a"]]);
    expect(enumeratePaths(g, "a", "zz")).toEqual([]);
    expect(enumeratePaths(g, "a", "d", { maxPaths: 0 })).toEqual([]);
    expect(enumeratePaths(g, "a", "d", { maxDepth: 2 })).toEqual([["a", "c", "d"]]);
    expect(enumeratePaths(g, "a", "d", { maxPaths: 1 })).toHaveLength(1);
  });
});

describe("IPOG pairwise", () => {
  const sizes = fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 6 });

  it("property: every pair is covered, rows are in range, size ≤ full product", () => {
    fc.assert(
      fc.property(sizes, (sz) => {
        const rows = ipog(sz);
        expect(uncoveredPairs(sz, rows)).toEqual([]);
        for (const r of rows) {
          expect(r).toHaveLength(sz.length);
          r.forEach((v, i) => {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(sz[i] as number);
          });
        }
        expect(rows.length).toBeLessThanOrEqual(sz.reduce((a, b) => a * b, 1));
        if (sz.length >= 2) {
          const sorted = [...sz].sort((a, b) => b - a);
          expect(rows.length).toBeGreaterThanOrEqual((sorted[0] as number) * (sorted[1] as number));
        }
      }),
    );
  });

  it("property: with a constraint every row is valid and every feasible pair is covered", () => {
    fc.assert(
      fc.property(sizes, fc.integer({ min: 0, max: 3 }), (sz, banned) => {
        // forbid parameter 0 and 1 both taking value `banned` (each needs a 2nd value so every
        // pair that is feasible alone also extends to a full valid row)
        fc.pre(sz.length < 2 || ((sz[0] as number) >= 2 && (sz[1] as number) >= 2));
        const constraint = (r: (number | undefined)[]) => !(r[0] === banned && r[1] === banned);
        const rows = ipog(sz, { constraint });
        for (const r of rows) expect(constraint(r)).toBe(true);
        expect(uncoveredPairs(sz, rows, constraint)).toEqual([]);
      }),
    );
  });

  it("degenerate inputs", () => {
    expect(ipog([])).toEqual([]);
    expect(ipog([3, 0, 2])).toEqual([]);
    expect(ipog([3])).toEqual([[0], [1], [2]]);
    expect(ipog([3], { constraint: (r) => r[0] !== 1 })).toEqual([[0], [2]]);
    expect(ipog([2, 2, 2], { constraint: () => false })).toEqual([]);
  });
});
