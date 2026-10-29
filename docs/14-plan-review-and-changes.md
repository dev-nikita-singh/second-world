# 14 — Plan Review & Changes (v1 → v2)

A review of `SecondWorld_plan.txt` (v1). v1 had a strong vision, good modularity, and good honesty principles. v2 keeps all of it and fixes gaps that would have caused wrong measurements, portability failures or costly refactors.

## 1. What v1 got right (kept)

- Modular, independently usable engines.
- A clear distinction between facts, defects, risks and hypotheses.
- Safety-first defaults (local/staging, approvals, no code execution).
- Modular monolith in TypeScript, incremental roadmap, measurable success criteria.

## 2. Gaps found & fixes

### Measurement correctness

| # | Gap in v1 | Risk | v2 fix |
|---|---|---|---|
| 1 | No mention of **coordinated omission** | p99 under-reported by orders of magnitude during stalls | Open-loop scheduler with intended-start timing + HDR expected-interval correction ([DSA §3.5](04-data-structures-and-algorithms.md#35-coordinated-omission-correction)) |
| 2 | "Virtual users or request rate" treated as interchangeable | Results misinterpreted | Explicit closed/open/iterations models with documented semantics |
| 3 | Percentile method left open | Tools disagree at tails | HDR nearest-rank, 3 significant digits, documented in each report |
| 4 | Generator bottleneck mentioned but no method | False "server is slow" conclusions | Self-check: event-loop lag, scheduling lag, achieved-rate gap, Little's Law |
| 5 | "Statistically convincing" undefined | Noise reported as improvement | Repetitions, interleaving, bootstrap CI, Mann–Whitney, Cliff's δ, Holm, A/A noise floor |
| 6 | No warm-up handling | Cold JIT/caches skew results | `warmup` phase excluded and reported separately |
| 7 | No determinism | Irreproducible runs | Seeded PRNG streams, recorded seeds, replay commands |

### Robustness & portability ("works in every environment")

| # | Gap | v2 fix |
|---|---|---|
| 8 | No environment detection | Environment probe + `sw doctor` + capability matrix + graceful degradation ([06](06-environments-and-portability.md)) |
| 9 | Windows/macOS/Linux differences not considered | Rules for paths, signals, process trees, ports, line endings, encoding, long paths |
| 10 | Containers (cgroup CPU/mem limits) ignored | cgroup-aware worker count and memory warnings |
| 11 | `localhost` → `::1` pitfall in Node ≥ 17 | Detect & fallback with hint |
| 12 | Proxies/custom CAs/offline not considered | Proxy env support for tool calls, off for targets. Custom CA. Fully offline core |
| 13 | Native dependencies not ruled out | No native addons. WASM only |
| 14 | No cancellation design | AbortSignal tree, graceful/hard stop, partial reports, cleanup stack |
| 15 | No exit-code specification | Defined exit codes 0/1/2/3/4/5/70/130 + `--fail-on` |
| 16 | **TypeScript version risk**: `typescript@latest` is now 7.x (Go-native) without the stable JS Compiler API | Use `typescript@^6` behind a `SourceAnalyzer` adapter. Track the TS 7 API |
| 17 | Node version not specified | `engines: >=22.19.0`, CI on 22/24/26 |

### Dynamism & extensibility

| # | Gap | v2 fix |
|---|---|---|
| 18 | No plugin model | Plugin API with 10 extension points, presets, namespacing ([10](10-plugins-and-extensibility.md)) |
| 19 | Engines eagerly coupled in one package | Lazy dynamic imports, subpath exports, layer rules enforced by dependency-cruiser |
| 20 | No workflow composition mechanism | Orchestrator with DAG workflows (Kahn), parallel steps, `continueOnError` |
| 21 | Config format undefined | Layered config (CLI > env > profile > file > extends > defaults), units, profiles, secrets refs, JSON Schema export |

### Evidence & reporting

| # | Gap | v2 fix |
|---|---|---|
| 22 | Finding model too thin (string evidence) | Typed discriminated-union evidence, classification ladder L0–L5, fingerprint, occurrences, relations |
| 23 | No dedup across runs | Stable fingerprints → open/fixed/regressed tracking |
| 24 | Severity subjective | Derived from impact × likelihood |
| 25 | Only terminal/JSON outputs | + Markdown, JUnit, SARIF, HTML, job summaries |
| 26 | No report schema versioning | `schemaVersion` + migrations, immutable reports with hashes |

### Engine-level improvements

| Engine | Additions |
|---|---|
| Stress | Breakpoint mode with bisection, stop conditions, Kneedle, USL (labelled estimate), spike recovery time, soak drift (Theil–Sen + CUSUM) |
| Architecture | Concrete extractor list, 12 rules with IDs, suppressions, cache, CSR graphs, betweenness, layer rules, multi-language path via tree-sitter WASM |
| Bug Hunter | Discovery mode, pairwise (IPOG), model-based testing, linearizability, replay protocol & flakiness (Wilson), shrinking + ddmin, false-positive controls |
| Agent | Heuristic planner, bandit selection, scenario DSL, safety validator, request/time/iteration budgets |
| Reliability | Built-in fault proxy (no Docker needed), guaranteed revert + TTL, steady-state hypotheses, retry amplification, isolation analysis |
| System Model | Evidence-weighted confidence (noisy-OR), entity resolution via union-find, trace critical path, snapshot diff |
| What-If/Evolution | Experimental design (interleaving, A/A), git worktree isolation, Docker sandbox, Pareto ranking |
| Summary | Deterministic cross-report summary (`sw analyze`): counts, strongest evidence, top findings, invalidating limitations |
| History | JSONL → `node:sqlite`, retention, CUSUM/MAD anomalies, integrity verification |

### Safety

| # | Gap | v2 fix |
|---|---|---|
| 27 | No threat model | Threat table with controls ([11](11-safety-security-privacy.md)) |
| 28 | DNS rebinding / redirect escape / template SSRF | DNS pinning, redirect allow-list, post-template host checks |
| 29 | Hostile content in response bodies/code | Untrusted-data handling: parsed and recorded, never executed |
| 30 | Audit trail unspecified | Hash-chained append-only audit log |

### Document defects fixed

- The file is **Windows-1252 encoded**. Characters such as `−`, `×`, `→` and the tree-drawing characters were corrupted (`?`, `�`). v2 docs are UTF-8.
- The boundary-value example was corrupted. The correct values for 1..100 are **0, 1, 2, 99, 100, 101**.
- The formula `Latency = Request completion time ? Request start time` should read **completion − start**. `Failed/Total � 100%` should read **× 100 %**.
- The tables in §2 and §18 had lost their column separators. They are restored as proper tables.
- The proposed folder tree was unreadable. It has been redrawn in [02 – Architecture §3](02-architecture.md#3-source-layout-v2).

## 3. Roadmap changes

- Stress Lab + History moved from Phase 7 to Phase 3. They are cheap once Perf exists and they make CI regression detection useful early.
- Evidence types are defined in Phase 1 to avoid a refactor in Phase 5/6.
- A Phase 0 of spikes has been added to de-risk the HTTP engine, CO correction and the TypeScript API.
- Every phase now has concrete acceptance numbers.

## 4. Later change: fully deterministic (2026-10-29)

SECOND WORLD is fully deterministic: no AI or LLM is used anywhere, and every result comes from measurement, analysis or code. The analysis layer was replaced by a deterministic cross-report summary (`sw analyze`), and the Adversarial Test Agent uses only its heuristic planner and bandit.
