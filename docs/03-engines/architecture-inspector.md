# Architecture Inspector

> Statically analyses source code and config to build a **component graph**, request paths and **potential** risks. It never executes project code.

## 1. Pipeline

```text
discover ─► parse ─► bind/resolve ─► extract ─► build graph ─► analyse graph ─► apply rules ─► findings
   │           │          │             │            │              │                │
 globby +   TS Program  TypeChecker   framework     DiGraph      Tarjan SCC,     rule engine
 .gitignore  (no emit)  symbol res.   extractors    + evidence   fan-in/out,     (built-in +
 tsconfig                             (express,     per edge     impact, paths   plugin rules)
 discovery                            fastify,...)
```

1. **Discover**: the project path must be an existing directory; a missing path or a file is a usage error (`SW_CONFIG_PROJECT`, exit 2). An existing directory without TypeScript/JavaScript sources has nothing to inspect: the run ends with status `error`, the `ARCH_NO_FILES` limitation (impact `invalidates`) and exit 5 ("nothing measured"), so a CI job pointed at the wrong folder does not pass. Find `tsconfig*.json` (supports project references and monorepo workspaces: npm/pnpm/yarn). Respect `.gitignore` and `.swignore`. Skip `node_modules`, `dist`, generated code, and files > 1 MB (configurable).
2. **Parse**: `ts.createProgram` with `noEmit`, `skipLibCheck`, `allowJs` (JS projects supported). Uses the TypeChecker for import resolution and call-target resolution. Incremental: a content-hash cache per file (SHA-256) skips re-extraction of unchanged files.
3. **Extract**: framework extractors are plugins (`Extractor` interface). Built in for v1: **Express, Fastify, NestJS (decorators), Hono, Koa, Next.js route handlers**. Also extracts DB clients (`pg`, `mysql2`, Prisma, TypeORM, Drizzle, Mongoose, Knex, `node:sqlite` `DatabaseSync` and `better-sqlite3` `.prepare`/`.exec`), HTTP clients (`fetch`, axios, got, undici), caches (`ioredis`, `redis`), and queues (BullMQ, amqplib, kafkajs, SQS SDK). When source files were analysed but no route (e.g. hand-written `node:http` dispatch) or no database access was recognised, the run says so: limitations `ARCH_NO_ROUTES` / `ARCH_NO_DB_ACCESS` (impact `reduces-confidence`) name the supported frameworks/drivers and the rules that therefore had nothing to check.
4. **Build graph**: nodes = route, handler, service, repository, client, datastore, external-service, queue, cache, module. Edges = `calls`, `imports`, `reads`, `writes`, `publishes`, `consumes`, `configures`. Each edge stores **evidence** (`file:line:col`, snippet hash, extractor id, confidence).
5. **Analyse**: SCCs/cycles, fan-in/fan-out, depth of request paths, reachability (route → datastore), impact sets, optional betweenness centrality for "hub" components.
6. **Rules**: evaluated over AST nodes and the graph.

## 2. Data structures

- **AST**: TypeScript's own `ts.Node` tree, walked with an iterative visitor (explicit stack) to avoid recursion limits on huge files.
- **Symbol table**: TypeChecker plus our `Map<SymbolId, ComponentId>` index.
- **Graph**: adjacency lists `Map<NodeId, Set<NodeId>>` for out-edges **and** in-edges (reverse index for O(1) "who depends on me").
- **Interning**: file paths and component IDs are interned into integer IDs. Graph algorithms run on `Int32Array`-based CSR (compressed sparse row) for large repos.

See [DSA §5](../04-data-structures-and-algorithms.md#5-graph-algorithms).

## 3. Graph queries (examples)

| Question | Algorithm | Complexity |
|---|---|---|
| Which endpoints reach `PaymentClient`? | Reverse BFS from client, filter `route` nodes | O(V+E) |
| What breaks if Redis is down? | Reverse BFS (impact set) | O(V+E) |
| Module cycles? | Tarjan SCC (iterative), report SCCs with size > 1 and their shortest cycle (BFS inside SCC) | O(V+E) |
| Layer violations (controller → repository skipping service)? | Edge pattern match on node kinds | O(E) |
| Longest request path / deep chains | DAG longest path on condensation graph (topological DP) | O(V+E) |
| Highly coupled hubs | Fan-in × fan-out, Brandes betweenness (opt-in) | O(V+E) / O(VE) |

## 4. Built-in rules (v1)

| ID | Rule | Default severity | Classification |
|---|---|---|---|
| ARCH001 | Outbound HTTP call with no identifiable timeout/AbortSignal | high | suspected-risk |
| ARCH002 | Retry loop/config with no max attempts or no backoff | high | suspected-risk |
| ARCH003 | Module dependency cycle | medium | suspected-risk |
| ARCH004 | Sync heavy work in handler (`fs.*Sync`, `crypto.*Sync`, `JSON.parse` on unbounded input, `child_process.execSync`) | medium | suspected-risk |
| ARCH005 | DB query inside loop (possible N+1) | medium | suspected-risk |
| ARCH006 | DB pool size missing or `< expected concurrency` (from config or perf run) | medium | suspected-risk |
| ARCH007 | Route without auth middleware where siblings have one | high | suspected-risk |
| ARCH008 | Handler depends on ≥ N distinct external systems (fan-out) | low | suspected-risk |
| ARCH009 | Unbounded in-memory cache / global array growth | low | suspected-risk |
| ARCH010 | Secrets hard-coded (high-entropy string + key-like name) | high | suspected-risk |
| ARCH011 | Missing `await` on promise in handler (floating promise) | medium | suspected-risk |
| ARCH012 | Layer violation (configurable layer map) | low | suspected-risk |

Rules are declarative where possible (node kind + predicate). Each rule has an id, docs URL, default severity, `fix hint`, and can be configured as `off | warn | error` with options, ESLint-style. Inline suppression: `// sw-ignore ARCH001 reason`.

## 5. Honesty & limitations

The report always includes `limitations[]`, for example: dynamic `require`/`import()` with computed paths, dependency injection resolved at runtime, reflection, env-dependent wiring, code in unsupported languages, and the production topology (replicas, load balancers). Edges derived from naming heuristics get `confidence < 0.6` and a separate label.

## 6. Multi-language roadmap

TypeScript/JavaScript first (TS Compiler API, which is the most accurate). Python, Go and Java later via **web-tree-sitter** (WASM, so no native build) with language-specific extractor packs. The graph and rules layer stays language-agnostic.

## 7. Usage

```bash
sw inspect ./ --format html --out reports/arch.html
sw inspect ./ --rule ARCH004=off --graph dot > graph.dot
```

```ts
const r = await world.architecture.inspect({ project: "./", tsconfig: "tsconfig.json" });
r.data.graph.impactOf("datastore:postgres");
```

## 8. Performance targets

| Repo size | Cold | Warm (cache) | Peak RSS |
|---|---|---|---|
| 1k files | < 15 s | < 3 s | < 600 MB |
| 10k files | < 2 min | < 20 s | < 2.5 GB (use `--max-files`, sharded workers) |

See [05 – Optimization §3](../05-optimization.md#3-architecture-inspector).
