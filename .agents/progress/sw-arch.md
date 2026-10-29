# Progress: sw-arch

## Done (all deliverables) — status: DONE, contracts READY in CONTRACTS.md "sw-arch"
- Engine `src/engines/architecture/**`: schema.ts, discovery.ts (tsconfig JSONC + extends/references, npm/pnpm/yarn workspaces,
  nested .gitignore + .swignore, default ignores, size/generated skipping, unsupported-language count), glob.ts, suppress.ts,
  cache.ts (per-file facts, dep-hash validation, atomic write), graph.ts (ArchitectureGraph on shared DiGraph, prefix composition,
  auth coverage, toDot/toMermaid/toJSON/impactOf), analyses.ts (SCC cycles + shortest example, hubs, reachability, impact,
  deepest chain on condensation DAG), rules/index.ts (ARCH001–ARCH012 all implemented), engine.ts, index.ts.
- TS adapter `analyzer/ts/**` (only place importing `typescript`, lazily): context.ts (origin resolution, units, emitters),
  walker.ts (iterative, kind-indexed dispatch, loop tracking), extractors/core.ts (imports, calls), routes.ts (Express, Fastify,
  Hono, Koa, Nest, Next.js), clients.ts (fetch/axios/got/undici/node:http; pg/mysql2/prisma/typeorm/drizzle/mongoose/knex +
  repo-class heuristic; ioredis/redis; bullmq/amqplib/kafkajs/SQS; ARCH006 pool size), detectors.ts (ARCH002/004/009/010/011),
  define-rule.ts (plugin AST rules).
- Tests: 48 passing (unit 41 in tests/unit/architecture: extractors 13, rules 16, engine 12; integration 7 in
  tests/integration/architecture: fixtures 3, examples 4). Fixture repos tests/fixtures/arch/{express-api,fastify-api,nest-api}.
- Examples: shop-express recall 5/5, precision 5/6 (extra: ARCH005 services/orders.ts:29 — real per-line query in a loop);
  shop-fastify recall 3/3, precision 3/3. Warm cache run ≈ 50 ms vs ≈ 1.4 s cold, identical results.
- tsc clean for my files (errors only in tests/integration/bugs/* — not mine). biome clean on my paths.

## Next
- (none) Possible follow-ups: Brandes betweenness (opt-in), worker_threads sharding for huge monorepos, CSR/interning for 10^5 nodes,
  interprocedural N+1 (call-in-loop to a function that queries), cross-workspace symbol resolution without node_modules links.

## Decisions
- Layout: language-agnostic facts/graph/rules; `analyzer/source-analyzer.ts` = adapter interface; `analyzer/ts/**` = TS adapter.
- FileFacts JSON cached in `<project>/.second-world/cache/arch/facts-<ns>.json`; ns = sha(engine version + analyzer signature
  (adapter, typescript version, extractor ids@versions) + tsconfig chain text + frameworks + workspaces). Entry valid iff file hash
  and the hashes of its directly-imported project files are unchanged (missing relative imports also tracked).
- Program: rootNames = cache misses only; options from tsconfig + noEmit/skipLibCheck/allowJs/types:[]/plugins:[]. TypeChecker only
  queried on candidate nodes (call targets, receivers, ExpressionStatements for ARCH011).
- Datastore heuristic for project classes named *Db/*Repository/*Dao/*Store/DataSource: confidence 0.5, edges marked heuristic.
- Type-only and dynamic imports excluded from ARCH003 cycle graph.
- Rule levels default: error for ARCH001/002/007/010, warn otherwise; status failed iff any error-level finding.
- ARCH008 default max = 4 external systems (3 flagged ordinary db+cache+queue handlers).
- ARCH012 is a no-op (with limitation) unless a layer map is configured.
- Fingerprint = fingerprint([rule, file, symbol, sha(snippet)]) (+ ordinal for duplicates); ARCH003/007/008 use semantic parts.
- Secrets never appear in findings (snippet replaced by `<name>=<secret:sha12>`).
- Never run the inspector on examples/** without cacheDir in a temp dir (would write .second-world into examples/).

## Blockers / requests
- none. FYI main: `npx tsc --noEmit` reports errors in tests/integration/bugs/shop-*.test.ts (`seed` not in Partial<EngineContext>) — not mine.
