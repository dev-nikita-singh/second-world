import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findCycles, shortestCycle } from "../../../src/shared/graph/cycles.js";
import { DiGraph } from "../../../src/shared/graph/digraph.js";
import { impactDetails, impactOf } from "../../../src/shared/graph/impact.js";
import { longestPath } from "../../../src/shared/graph/paths.js";
import { condensation, cyclicSccs, tarjanScc } from "../../../src/shared/graph/scc.js";
import { CycleError, isDag, topoLevels, topoSort } from "../../../src/shared/graph/toposort.js";
import { bfs, dfs, enumeratePaths, reachable, shortestPath } from "../../../src/shared/graph/traverse.js";

const graphArb = fc.integer({ min: 1, max: 12 }).chain((n) =>
  fc.tuple(
    fc.constant(n),
    fc.array(fc.tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 })), {
      maxLength: n * 3,
    }),
  ),
);

function build(n: number, edges: [number, number][]): DiGraph {
  const g = new DiGraph();
  for (let i = 0; i < n; i++) g.addNode(`n${i}`);
  for (const [a, b] of edges) g.addEdge(`n${a}`, `n${b}`);
  return g;
}

/** Brute-force reachability closure (Floyd–Warshall style). */
function closure(g: DiGraph): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const v of g.nodes()) m.set(v, reachable(g, v));
  return m;
}

function chain(n: number): DiGraph {
  const g = new DiGraph();
  for (let i = 0; i < n; i++) g.addNode(String(i));
  for (let i = 0; i + 1 < n; i++) g.addEdge(String(i), String(i + 1));
  return g;
}

describe("DiGraph", () => {
  it("adds nodes/edges with forward and reverse adjacency and multi-evidence", () => {
    const g = new DiGraph<{ kind: string }, string>();
    g.addNode("a", { kind: "svc" });
    g.addEdge("a", "b", "import");
    g.addEdge("a", "b", "http");
    g.addEdge("b", "c");
    expect(g.nodes()).toEqual(["a", "b", "c"]);
    expect(g.nodeData("a")).toEqual({ kind: "svc" });
    expect(g.edgeData("a", "b")).toEqual(["import", "http"]);
    expect(g.edgeCount).toBe(2);
    expect(g.successors("a")).toEqual(["b"]);
    expect(g.predecessors("c")).toEqual(["b"]);
    expect(g.hasEdge("b", "a")).toBe(false);
    expect(g.inDegree("b")).toBe(1);
    expect(g.outDegree("a")).toBe(1);
    expect(g.reverse().hasEdge("b", "a")).toBe(true);
    expect(g.reverse().edgeData("b", "a")).toEqual(["import", "http"]);
    expect(g.subgraph(["a", "b"]).edgeCount).toBe(1);
    expect(g.removeNode("b")).toBe(true);
    expect(g.edgeCount).toBe(0);
    expect(g.successors("a")).toEqual([]);
    expect(g.removeEdge("x", "y")).toBe(false);
  });

  it("toCsr mirrors adjacency", () => {
    fc.assert(
      fc.property(graphArb, ([n, edges]) => {
        const g = build(n, edges);
        const c = g.toCsr();
        for (let i = 0; i < c.ids.length; i++) {
          const succ = Array.from(c.targets.subarray(c.offsets[i], c.offsets[i + 1]), (k) => c.ids[k]);
          expect(succ).toEqual(g.successors(c.ids[i] as string));
          const pred = Array.from(c.rTargets.subarray(c.rOffsets[i], c.rOffsets[i + 1]), (k) => c.ids[k]);
          expect(pred).toEqual(g.predecessors(c.ids[i] as string));
        }
      }),
    );
  });
});

describe("traversal", () => {
  it("bfs depth/parent and reverse", () => {
    const g = new DiGraph();
    g.addEdge("a", "b").addEdge("b", "c").addEdge("a", "c").addEdge("c", "d");
    const r = bfs(g, "a");
    expect(r.order).toEqual(["a", "b", "c", "d"]);
    expect(r.depth.get("d")).toBe(2);
    expect(r.parent.get("d")).toBe("c");
    expect(bfs(g, "a", { maxDepth: 1 }).order).toEqual(["a", "b", "c"]);
    expect([...reachable(g, "d", { reverse: true })].sort()).toEqual(["a", "b", "c", "d"]);
    expect(shortestPath(g, "a", "d")).toEqual(["a", "c", "d"]);
    expect(shortestPath(g, "d", "a")).toBeNull();
    expect(bfs(g, "missing").order).toEqual([]);
  });

  it("dfs pre/post order", () => {
    const g = new DiGraph();
    g.addEdge("a", "b").addEdge("b", "c").addEdge("a", "d");
    const r = dfs(g, "a");
    expect(r.preorder).toEqual(["a", "b", "c", "d"]);
    expect(r.postorder).toEqual(["c", "b", "d", "a"]);
    expect(dfs(g).preorder).toHaveLength(4);
  });

  it("enumeratePaths is bounded and returns simple paths", () => {
    const g = new DiGraph();
    g.addEdge("a", "b").addEdge("a", "c").addEdge("b", "d").addEdge("c", "d").addEdge("d", "a");
    const ps = enumeratePaths(g, "a", "d");
    expect(ps).toEqual([
      ["a", "b", "d"],
      ["a", "c", "d"],
    ]);
    expect(enumeratePaths(g, "a", "d", { maxPaths: 1 })).toHaveLength(1);
    expect(enumeratePaths(g, "a", "d", { maxDepth: 1 })).toEqual([]);
    expect(enumeratePaths(g, "a", "d", { maxDepth: 2 })).toHaveLength(2);
    expect(enumeratePaths(g, "a", "a")).toEqual([["a"]]);
  });

  it("impactOf = reverse reachability excluding the start", () => {
    const g = new DiGraph();
    // api -> orders -> db ; api -> users -> db ; worker -> queue
    g.addEdge("api", "orders").addEdge("orders", "db").addEdge("api", "users").addEdge("users", "db");
    g.addEdge("worker", "queue");
    expect(impactOf(g, "db").sort()).toEqual(["api", "orders", "users"]);
    expect(impactDetails(g, "db").find((e) => e.id === "api")?.depth).toBe(2);
    expect(impactOf(g, "db", { maxDepth: 1 }).sort()).toEqual(["orders", "users"]);
    expect(impactOf(g, "worker")).toEqual([]);
  });
});

describe("Tarjan SCC", () => {
  it("agrees with brute-force mutual reachability on random graphs", () => {
    fc.assert(
      fc.property(graphArb, ([n, edges]) => {
        const g = build(n, edges);
        const cl = closure(g);
        const sccs = tarjanScc(g);
        // partition of all nodes
        expect(sccs.flat().sort()).toEqual(g.nodes().sort());
        const compOf = new Map<string, number>();
        sccs.forEach((c, i) => {
          for (const v of c) compOf.set(v, i);
        });
        for (const u of g.nodes()) {
          for (const v of g.nodes()) {
            const mutual = (cl.get(u) as Set<string>).has(v) && (cl.get(v) as Set<string>).has(u);
            expect(compOf.get(u) === compOf.get(v)).toBe(mutual);
          }
        }
        // emitted in reverse topological order: edges between components go from later to earlier
        for (const e of g.edges()) {
          expect(compOf.get(e.from) as number).toBeGreaterThanOrEqual(compOf.get(e.to) as number);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("cyclicSccs and condensation", () => {
    const g = new DiGraph();
    g.addEdge("a", "b").addEdge("b", "a").addEdge("b", "c").addEdge("d", "d");
    const cyc = cyclicSccs(g).map((c) => [...c].sort());
    expect(cyc).toContainEqual(["a", "b"]);
    expect(cyc).toContainEqual(["d"]);
    expect(cyc).toHaveLength(2);
    const cond = condensation(g);
    expect(isDag(cond.dag)).toBe(true);
    expect(cond.componentOf.get("a")).toBe(cond.componentOf.get("b"));
    expect(cond.componentOf.get("a")).toBeLessThan(cond.componentOf.get("c") as number);
  });

  it("handles a 100k-node chain and a 100k-node ring without recursion", () => {
    const n = 100_000;
    const g = chain(n);
    expect(tarjanScc(g)).toHaveLength(n);
    g.addEdge(String(n - 1), "0");
    const ring = tarjanScc(g);
    expect(ring).toHaveLength(1);
    expect(ring[0]).toHaveLength(n);
  });
});

describe("topological sort", () => {
  it("respects every edge on random DAGs", () => {
    fc.assert(
      fc.property(graphArb, ([n, edges]) => {
        const dagEdges = edges.filter(([a, b]) => a < b) as [number, number][];
        const g = build(n, dagEdges);
        const order = topoSort(g);
        expect(order).toHaveLength(n);
        const pos = new Map(order.map((v, i) => [v, i]));
        for (const e of g.edges()) expect(pos.get(e.from) as number).toBeLessThan(pos.get(e.to) as number);
        const levels = topoLevels(g);
        const lvl = new Map<string, number>();
        levels.forEach((l, i) => {
          for (const v of l) lvl.set(v, i);
        });
        expect(lvl.size).toBe(n);
        for (const e of g.edges()) expect(lvl.get(e.from) as number).toBeLessThan(lvl.get(e.to) as number);
      }),
      { numRuns: 300 },
    );
  });

  it("throws CycleError with a real cycle path on cyclic graphs", () => {
    fc.assert(
      fc.property(graphArb, ([n, edges]) => {
        const g = build(n, edges);
        const hasCycle = cyclicSccs(g).length > 0;
        expect(isDag(g)).toBe(!hasCycle);
        if (!hasCycle) return;
        let err: unknown;
        try {
          topoSort(g);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(CycleError);
        const cyc = (err as CycleError).cycle;
        expect(cyc.length).toBeGreaterThan(0);
        for (let i = 0; i < cyc.length; i++) {
          expect(g.hasEdge(cyc[i] as string, cyc[(i + 1) % cyc.length] as string)).toBe(true);
        }
        expect(() => topoLevels(g)).toThrow(CycleError);
      }),
      { numRuns: 300 },
    );
  });

  it("message shows the cycle path", () => {
    const g = new DiGraph();
    g.addEdge("build", "test").addEdge("test", "deploy").addEdge("deploy", "build").addEdge("x", "build");
    expect(() => topoSort(g)).toThrow(
      /build -> test -> deploy -> build|test -> deploy -> build -> test|deploy -> build -> test -> deploy/,
    );
  });

  it("is deterministic (insertion order ties) and handles a 100k chain", () => {
    const g = new DiGraph();
    for (const id of ["c", "a", "b"]) g.addNode(id);
    expect(topoSort(g)).toEqual(["c", "a", "b"]);
    const big = chain(100_000);
    const order = topoSort(big);
    expect(order[0]).toBe("0");
    expect(order[99_999]).toBe("99999");
    expect(bfs(big, "0").order).toHaveLength(100_000);
    expect(dfs(big, "0").postorder[0]).toBe("99999");
    expect(longestPath(big).length).toBe(99_999);
  });
});

describe("cycles", () => {
  it("shortestCycle finds the minimal cycle", () => {
    const g = new DiGraph();
    // long cycle a→b→c→d→a and short b→e→b
    g.addEdge("a", "b")
      .addEdge("b", "c")
      .addEdge("c", "d")
      .addEdge("d", "a")
      .addEdge("b", "e")
      .addEdge("e", "b");
    const c = shortestCycle(g) as string[];
    expect(c).toHaveLength(2);
    expect([...c].sort()).toEqual(["b", "e"]);
    g.addEdge("c", "c");
    expect(shortestCycle(g)).toEqual(["c"]);
    expect(shortestCycle(chain(5))).toBeNull();
  });

  it("shortestCycle length equals brute-force minimum on random graphs", () => {
    fc.assert(
      fc.property(graphArb, ([n, edges]) => {
        const g = build(n, edges);
        // brute force: min over edges u→v of 1 + dist(v, u)
        let best = Number.POSITIVE_INFINITY;
        for (const e of g.edges()) {
          const d = bfs(g, e.to).depth.get(e.from);
          if (d !== undefined) best = Math.min(best, d + 1);
        }
        const c = shortestCycle(g);
        if (best === Number.POSITIVE_INFINITY) expect(c).toBeNull();
        else expect(c?.length).toBe(best);
        for (const cyc of findCycles(g)) {
          for (let i = 0; i < cyc.length; i++) {
            expect(g.hasEdge(cyc[i] as string, cyc[(i + 1) % cyc.length] as string)).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("longestPath", () => {
  it("edge-count default and node weights (critical path)", () => {
    const g = new DiGraph<number>();
    g.addNode("a", 5).addNode("b", 1).addNode("c", 10).addNode("d", 2);
    g.addEdge("a", "b").addEdge("a", "c").addEdge("b", "d").addEdge("c", "d");
    expect(longestPath(g).length).toBe(2);
    const r = longestPath(g, { nodeWeight: (id) => g.nodeData(id) ?? 0, edgeWeight: () => 0 });
    expect(r.length).toBe(17);
    expect(r.path).toEqual(["a", "c", "d"]);
    const cyc = new DiGraph();
    cyc.addEdge("x", "y").addEdge("y", "x");
    expect(() => longestPath(cyc)).toThrow(CycleError);
    expect(longestPath(new DiGraph()).length).toBe(0);
  });
});
