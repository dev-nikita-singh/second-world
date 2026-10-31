/**
 * Architecture enforcement: layering and cycles of src/ (docs/02-architecture.md §2,
 * docs/16-system-design.md §1). Fails CI when a new import breaks the dependency rule.
 *
 * Rules (as documented, with the composition-root exception made explicit):
 *  R1 core ↛ cli, adapters. core → engines only by dynamic import() (or type-only) and only from the
 *     composition root (core/registry.ts, core/world.ts) — that is the lazy engine loading of
 *     docs/02 §4.1.
 *  R2 shared is a leaf: it imports nothing else from src/.
 *  R3 adapters ↛ engines, cli.
 *  R4 engines ↛ cli, index.
 *  R5 cli → engines only through an engine's public entry (engines/<x>/index.ts) and only lazily
 *     (dynamic import) or type-only, so `sw --version` / `sw --help` never load an engine.
 *  R6 engine → other engine: docs/02 §2 says "must not". The code base has known exceptions;
 *     they are frozen in KNOWN_CROSS_ENGINE below (a ratchet). A new pair fails; removing one
 *     makes the stale-entry test fail so the list shrinks with the code.
 *  R7 no import cycles among runtime (value) imports. Type-only cycles are frozen as a ratchet.
 */
import { describe, expect, it } from "vitest";
import { buildImportGraph, findCycles, type ImportEdge, layerOf } from "./import-graph.js";

const graph = buildImportGraph();
const fmt = (e: ImportEdge): string => `src/${e.from}:${e.line} -> src/${e.to} [${e.kind}]`;
const top = (layer: string): string => layer.split("/")[0] as string;

const COMPOSITION_ROOT = new Set(["core/registry.ts", "core/world.ts"]);

/**
 * Known engine → engine dependencies (importer engine -> imported engine). Each one is a deviation
 * from docs/02 §2 recorded in docs/16-system-design.md "Known gaps". Do not add to this list
 * without updating that section.
 */
const KNOWN_CROSS_ENGINE = [
  "agent -> bugs", // agent reuses bug-hunter generators/classifier/session (value)
  "experiments -> bugs", // what-if runs the bug hunter (dynamic)
  "experiments -> performance", // what-if/evolution measure with the perf engine (value)
  "experiments -> stress", // USL fit reuse (value)
  "history -> performance", // record shapes (type-only)
  "history -> stress", // record shapes (type-only)
  "model -> architecture", // static graph source (dynamic + type)
  "model -> bugs", // OpenAPI contract loader (value)
  "reliability -> performance", // workload driver (value)
  "reporting -> agent", // renderers need result types
  "reporting -> bugs",
  "reporting -> experiments",
  "reporting -> history",
  "reporting -> model", // includes model/export.ts (value) for graph rendering
  "reporting -> performance",
  "reporting -> reliability",
  "reporting -> stress",
  "stress -> performance", // stages are perf runs (value)
].sort();

/** Known type-only import cycles (no runtime effect). */
const KNOWN_TYPE_CYCLES = [["engines/performance/engine.ts", "engines/performance/shard.ts"]];

describe("import graph sanity", () => {
  it("parses a realistic number of relative imports", () => {
    expect(graph.length).toBeGreaterThan(500);
    // The parser must see all three kinds, otherwise the rules below are vacuous.
    expect(graph.some((e) => e.kind === "type")).toBe(true);
    expect(graph.some((e) => e.kind === "dynamic")).toBe(true);
  });
});

describe("layering (docs/02 §2)", () => {
  it("R1 core does not import cli or adapters, and reaches engines only lazily (or type-only) from the composition root", () => {
    const bad = graph.filter((e) => {
      if (top(layerOf(e.from)) !== "core") return false;
      const to = top(layerOf(e.to));
      if (to === "cli" || to === "adapters") return true;
      if (to === "engines") return !(e.kind !== "value" && COMPOSITION_ROOT.has(e.from));
      return false;
    });
    expect(bad.map(fmt)).toEqual([]);
  });

  it("R2 shared is a leaf layer", () => {
    const bad = graph.filter((e) => layerOf(e.from) === "shared" && layerOf(e.to) !== "shared");
    expect(bad.map(fmt)).toEqual([]);
  });

  it("R3 adapters do not import engines or cli", () => {
    const bad = graph.filter(
      (e) => layerOf(e.from) === "adapters" && ["engines", "cli"].includes(top(layerOf(e.to))),
    );
    expect(bad.map(fmt)).toEqual([]);
  });

  it("R4 engines do not import cli or the package entry", () => {
    const bad = graph.filter(
      (e) => top(layerOf(e.from)) === "engines" && ["cli", "index"].includes(layerOf(e.to)),
    );
    expect(bad.map(fmt)).toEqual([]);
  });

  it("nothing outside cli imports cli", () => {
    const bad = graph.filter((e) => layerOf(e.to) === "cli" && layerOf(e.from) !== "cli");
    expect(bad.map(fmt)).toEqual([]);
  });

  it("R5 cli reaches engines only through engines/<x>/index.ts, lazily or type-only", () => {
    const bad = graph.filter((e) => {
      if (layerOf(e.from) !== "cli" || top(layerOf(e.to)) !== "engines") return false;
      const publicEntry = /^engines\/[^/]+\/index\.ts$/.test(e.to);
      return !publicEntry || e.kind === "value";
    });
    expect(bad.map(fmt)).toEqual([]);
  });

  it("R6 cross-engine imports are limited to the known (documented) pairs", () => {
    const pairs = new Map<string, string>();
    for (const e of graph) {
      const a = layerOf(e.from);
      const b = layerOf(e.to);
      if (!a.startsWith("engines/") || !b.startsWith("engines/") || a === b) continue;
      const key = `${a.slice(8)} -> ${b.slice(8)}`;
      if (!pairs.has(key)) pairs.set(key, fmt(e));
    }
    const unknown = [...pairs].filter(([k]) => !KNOWN_CROSS_ENGINE.includes(k)).map(([, v]) => v);
    expect(unknown, "new engine -> engine import; use the Evidence Store / events / registry").toEqual([]);
    const stale = KNOWN_CROSS_ENGINE.filter((k) => !pairs.has(k));
    expect(stale, "dependency removed: delete it from KNOWN_CROSS_ENGINE and docs/16 Known gaps").toEqual([]);
  });
});

describe("cycles", () => {
  it("R7 there are no runtime (value) import cycles", () => {
    expect(findCycles(graph.filter((e) => e.kind === "value"))).toEqual([]);
  });

  it("type-only cycles are limited to the known ones", () => {
    expect(findCycles(graph.filter((e) => e.kind !== "dynamic"))).toEqual(KNOWN_TYPE_CYCLES);
  });
});
