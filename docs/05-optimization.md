# 05 — Optimization

How SECOND WORLD stays fast, lean and accurate. A load tester that is slow measures **itself**, not the target.

## 1. Global principles

| Principle | Technique |
|---|---|
| Pay only for what you use | Lazy `import()` of engines and heavy deps (TypeScript ≈ 10 MB, Playwright, Cytoscape). The CLI cold start target is **< 150 ms** for `sw --help`, **< 300 ms** to first request |
| Bounded memory | HDR histograms, reservoirs and ring buffers. Memory is O(endpoints × buckets), never O(requests) |
| Don't block the event loop | No sync I/O after startup. JSON serialisation of large reports is streamed. CPU-heavy work (AST, bootstrap) goes to worker threads |
| Measure the measurer | Generator self-health metrics are always on (event-loop delay via `perf_hooks.monitorEventLoopDelay`, CPU via `process.cpuUsage`) |
| Avoid allocation in hot paths | Pre-built requests, reused buffers, typed arrays, no closures per request where avoidable |
| Benchmark the tool | `tinybench`/`mitata` micro-benchmarks + end-to-end throughput tests in CI with regression gates |

## 2. Performance Lab (load generation)

1. **HTTP client = `undici` `Pool`/`Agent`** with keep-alive, a configurable `connections` count per origin, optional `pipelining` (HTTP/1.1), and HTTP/2 via `allowH2`. undici is several times faster than `http.request`/axios in Node because of its pooling and its llhttp parser.
2. **Pre-serialise** static bodies once (`Buffer`). Template bodies are compiled once into a function (no per-request template parsing).
3. **Headers** are pre-merged into a single array form, avoiding object spreading per request.
4. **Response handling**: if no assertion needs the body, consume and discard it (`body.dump()`) without allocating strings. Parse JSON only when an `expect`/`extract` needs it. Only the first N bytes are sampled for error reservoirs.
5. **Timing** with `performance.now()`. Detailed phase timing (DNS/connect/TLS/TTFB) via `diagnostics_channel` (`undici:request:*`), which can be turned off with `timing: "basic"` for maximum throughput.
6. **Worker threads** (`workers: "auto"`): one undici pool and HDR per worker, merged once per second. The main thread does only rendering and safety. This scales near-linearly with cores until the NIC or target saturates.
7. **Timers**: a single scheduler loop per worker instead of one `setTimeout` per request. A short `setImmediate` spin for sub-2 ms precision only in open-loop mode at high rates.
8. **Logging**: no per-request logs by default. Debug logging samples 1/N requests. `pino` with async destination.
9. **Live UI**: rendered at most 4 fps from aggregated windows, and disabled entirely in non-TTY/CI.
10. **OS limits** (detected by probe, with fixes suggested): file descriptors (`ulimit -n`), ephemeral port range & TIME_WAIT on Windows (`MaxUserPort`, `TcpTimedWaitDelay`), and Linux `net.ipv4.ip_local_port_range`. Keep-alive avoids port exhaustion in the first place.

**Target**: ≥ 30k req/s per core against a trivial local endpoint on modern hardware, without the generator being the bottleneck below 20k req/s at p99 accuracy.

## 3. Architecture Inspector

1. **One `ts.Program`** for the whole project, plus `skipLibCheck`, `noEmit` and `types: []` unless needed. Don't type-check, only bind and resolve on demand.
2. **Incremental cache**: per-file SHA-256 → extracted facts (JSON) in `.second-world/cache/arch/`. Unchanged files skip extraction. The cache key includes the tool version + tsconfig hash + extractor versions.
3. **Lazy TypeChecker queries**: only on candidate nodes (call expressions matching extractor patterns), never a full walk with symbol resolution.
4. **Kind-indexed dispatch** for extractors: O(nodes), not O(nodes × extractors).
5. **Parallelism**: for huge monorepos, shard by workspace package across `worker_threads`, each with its own Program, then merge graphs (union by stable IDs).
6. **Memory**: release the `ts.Program` after extraction. Intern strings. Convert to CSR for analyses. Expose `--max-old-space-size` guidance in `sw doctor`.
7. **File discovery**: `tinyglobby`/`fast-glob` with ignore patterns applied during the walk (not after), `followSymbolicLinks: false` by default (avoid loops in pnpm stores).

## 4. API Bug Hunter & Agent

- Ajv validators compiled once per schema and cached (LRU by schema hash). Compilation is the expensive part, validation is cheap.
- OpenAPI dereferenced once, with circular refs handled.
- Test cases generated lazily (generators/iterables) and streamed through the semaphore. Never materialise 100k cases in memory.
- Replays reuse the recorded request objects.

## 5. Statistics

- Bootstrap: B = 10,000 resamples over per-run summaries (n small), so it is fast. It uses `Float64Array` and in-place sampling indices. For large raw samples, block bootstrap or histogram-based resampling is used.
- Mann–Whitney via a sort of the combined sample (O(n log n)) with tie correction.
- Theil–Sen on downsampled series (≤ 2,000 points).

## 6. Reporting & history

- JSON reports are written via streaming stringify for large artifacts. Raw artifacts (HAR, time series) are separate files, gzip-compressed (`node:zlib`). The index stays small.
- HTML report: one self-contained file, with chart libs inlined and minified only when HTML is requested.
- History queries: JSONL index scan is O(runs), fine up to ~10k runs. Switch to the SQLite backend beyond that (indexed).

## 7. Cross-report summary (`sw analyze`)

- Loads only `engines/summary` (no engine, no network). One pass over all findings for the counts, then a sort for the top N: O(f log f) for f findings.
- Output is a fixed template filled from the reports, so the same reports always give the same summary.

## 8. Startup & packaging

- Bundle with `tsdown` (or `tsup`) to ESM + CJS for the API, ESM for the CLI, `target: node22`, tree-shaken, with heavy deps left **external** and lazily imported.
- `"sideEffects": false`, `exports` map with subpaths (`second-world/performance`, …) so library users can import a single engine.
- Use the Node compile cache: `module.enableCompileCache()` (Node ≥ 22.1) in the CLI entry, which speeds up warm starts noticeably.
- Optional standalone binaries later via Node **Single Executable Applications** (SEA) for users without Node.

## 9. Performance budgets (CI-enforced)

| Metric | Budget |
|---|---|
| `sw --help` cold start | < 150 ms |
| Package install size (no optional deps) | < 15 MB (TypeScript is a peer/optional dep if the user already has one) |
| Perf engine overhead vs raw undici loop | < 10 % throughput loss |
| Memory for 1 h open-loop test, 20 endpoints | < 300 MB RSS |
| Arch inspect 1k-file fixture (cold/warm) | < 15 s / < 3 s |
| Report write 100k findings | < 5 s |
