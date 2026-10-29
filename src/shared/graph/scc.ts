/**
 * Tarjan's strongly connected components, ITERATIVE — docs/04-data-structures-and-algorithms.md §5.4.
 * index / lowlink / onStack live in typed arrays over a CSR snapshot; recursion is simulated with
 * an explicit frame stack (node + edge cursor), so 10^5-node chains do not overflow the stack.
 * Components are emitted in Tarjan order (reverse topological order of the condensation:
 * sinks first); nodes inside a component follow stack-pop order.
 */
import { DiGraph } from "./digraph.js";

export function tarjanScc(g: DiGraph): string[][] {
  const { ids, offsets, targets } = g.toCsr();
  const V = ids.length;
  const index = new Int32Array(V).fill(-1);
  const low = new Int32Array(V);
  const onStack = new Uint8Array(V);
  const sccStack = new Int32Array(V);
  let sp = 0;
  const callNode = new Int32Array(V);
  const callEdge = new Int32Array(V);
  let cp = 0;
  let counter = 0;
  const result: string[][] = [];

  for (let root = 0; root < V; root++) {
    if (index[root] !== -1) continue;
    // push frame(root)
    index[root] = low[root] = counter++;
    sccStack[sp++] = root;
    onStack[root] = 1;
    callNode[cp] = root;
    callEdge[cp] = offsets[root] as number;
    cp++;
    while (cp > 0) {
      const v = callNode[cp - 1] as number;
      const e = callEdge[cp - 1] as number;
      if (e < (offsets[v + 1] as number)) {
        callEdge[cp - 1] = e + 1;
        const w = targets[e] as number;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          sccStack[sp++] = w;
          onStack[w] = 1;
          callNode[cp] = w;
          callEdge[cp] = offsets[w] as number;
          cp++;
        } else if (onStack[w] === 1) {
          if ((index[w] as number) < (low[v] as number)) low[v] = index[w] as number;
        }
        continue;
      }
      // all successors done: "return" from v
      cp--;
      if (low[v] === index[v]) {
        const comp: string[] = [];
        let w: number;
        do {
          w = sccStack[--sp] as number;
          onStack[w] = 0;
          comp.push(ids[w] as string);
        } while (w !== v);
        result.push(comp);
      }
      if (cp > 0) {
        const parent = callNode[cp - 1] as number;
        if ((low[v] as number) < (low[parent] as number)) low[parent] = low[v] as number;
      }
    }
  }
  return result;
}

/** SCCs that form cycles: size > 1, or a single node with a self-loop. */
export function cyclicSccs(g: DiGraph): string[][] {
  return tarjanScc(g).filter(
    (c) => c.length > 1 || (c.length === 1 && g.hasEdge(c[0] as string, c[0] as string)),
  );
}

export interface Condensation {
  /** Components in topological order of the condensation DAG (sources first). */
  components: string[][];
  /** node id → component index. */
  componentOf: Map<string, number>;
  /** DAG whose node ids are component indexes as strings ("0", "1", …). */
  dag: DiGraph<string[], never>;
}

/** Collapse each SCC into one node; the result is always a DAG. */
export function condensation(g: DiGraph): Condensation {
  const components = tarjanScc(g).reverse(); // topological order
  const componentOf = new Map<string, number>();
  components.forEach((c, i) => {
    for (const id of c) componentOf.set(id, i);
  });
  const dag = new DiGraph<string[], never>();
  components.forEach((c, i) => {
    dag.addNode(String(i), c);
  });
  for (const e of g.edges()) {
    const a = componentOf.get(e.from) as number;
    const b = componentOf.get(e.to) as number;
    if (a !== b) dag.addEdge(String(a), String(b));
  }
  return { components, componentOf, dag };
}
