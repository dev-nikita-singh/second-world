# 13 — Roadmap & Acceptance Criteria

Incremental delivery. Each phase ships a **usable** release, and no phase uses AI: SECOND WORLD is fully deterministic. Effort estimates assume 1–2 experienced TypeScript developers.

| Phase | Version | Theme | Est. |
|---|---|---|---|
| 0 | — | Spikes & decisions | 1 wk |
| 1 | 0.1 | Foundation | 2–3 wk |
| 2 | 0.2 | Performance Lab | 3–4 wk |
| 3 | 0.3 | Stress & Capacity + History (JSONL) + baselines | 2–3 wk |
| 4 | 0.4 | Architecture Inspector | 4–5 wk |
| 5 | 0.5 | API Bug Hunter | 4–5 wk |
| 6 | 0.6 | Evidence model v1, unified reports (MD/JUnit/SARIF/HTML), cross-report summary | 3–4 wk |
| 7 | 0.7 | Telemetry & System Model (OTel, entity resolution) | 4 wk |
| 8 | 0.8 | Reliability Lab | 3–4 wk |
| 9 | 0.9 | What-If + Evolution Engines | 4–5 wk |
| 10 | 0.10 | Adversarial Agent | 3–4 wk |
| 11 | 1.0 | Hardening, docs site, GitHub Action, Docker image, stability guarantees | 3 wk |

> **Change from v1 plan:** Stress + History move earlier (cheap once Perf exists, and they make CI regressions useful immediately). The Evidence model is defined in Phase 1 (types only), so engines don't need refactoring later.

---

## Phase 0 — Spikes

- Benchmark undici pool vs `fetch` vs k6 on the same box: confirm the native engine is within 2× of k6 for HTTP/1.1.
- Prototype open-loop scheduler + CO correction; validate against the stall fixture.
- Verify the `typescript@6` Compiler API on the fixture apps. Assess the maturity of the TS 7 `unstable` API.
- Confirm `node:sqlite` stability on Node 22.19+/24/26. (Wave 9: the SQLite backend works on Node 24 and is tested with a JSONL fallback; it still prints an ExperimentalWarning on 22/24, which SECOND WORLD hides.)
- **Output**: ADRs 001–011 confirmed or amended.

## Phase 1 — Foundation (0.1)

Build: package skeleton (ESM+CJS), CLI (`commander`), config loader (c12) + Zod schemas + units parser + profiles + env overlay, error hierarchy & exit codes, logger + redaction, clock/RNG/cancel utilities, event bus, Safety Guard v1 (allow-list, budgets), environment probe + `sw doctor`, `sw init`, Evidence/Finding types, JSON reporter, `shared/ds` + `shared/stats` basics, CI matrix (3 OS × 3 Node).

**Accept**: `sw doctor` runs correctly on Windows/macOS/Linux/Alpine. An invalid config shows the source-annotated errors with exit 2. A public target without allow-list gives exit 3.

## Phase 2 — Performance Lab (0.2)

Build: undici executor, closed/open/iterations models, ramp, Poisson, scenarios with extract/chain, data feeders, auth, thresholds grammar, HDR metrics, per-second windows, CO correction, generator self-check, worker threads, live TTY dashboard, JSON/TTY reports, graceful cancel.

**Accept** (against the calibrated fixture): accuracy tolerances in [12 §2](12-testing-and-quality.md#2-measurement-accuracy-test-suite-the-most-important-one). 1 h test memory < 300 MB. Ctrl+C produces a valid partial report.

## Phase 3 — Stress, History, Baselines (0.3)

Build: stage planner (step/ramp/spike/soak/breakpoint), stop conditions, knee detection, bisection refinement, recovery time, drift (Theil–Sen), JSONL history, baselines, statistical regression check, `sw history`, Markdown + JUnit reporters, GitHub job summary.

**Accept**: identifies the first breaching stage on a fixture with a known capacity cliff. History detects a seeded 20 % p95 regression with r = 5 and does not flag an A/A comparison (false positive rate ≤ 5 % over 100 A/A trials).

## Phase 4 — Architecture Inspector (0.4)

Build: discovery (monorepos, project refs), TS Program, extractors (Express, Fastify, Nest, Hono, Koa, Next), client/DB/queue detection, graph + evidence, Tarjan/BFS/impact, rules ARCH001–012, suppression comments, cache, DOT/Mermaid/JSON export, SARIF.

**Accept**: ≥ 90 % recall of known dependencies in fixtures. Every finding has a source location. Cold/warm budgets met. No user code executed (verified by a fixture that would write a file if executed).

## Phase 5 — API Bug Hunter (0.5)

Build: OpenAPI loading, Ajv validation, discovery mode, boundary/equivalence/pairwise generators, fast-check property & model-based tests, concurrency bursts + invariants + linearizability check, auth matrix, replay & flakiness (Wilson), shrinking/ddmin, `sw replay`.

**Accept**: reproduces all seeded API defects in fixtures. Precision ≥ 85 %. Documented 404s are not reported. Every defect has a working `sw replay` command.

## Phase 6 — Evidence, Reports, Summary (0.6)

Build: fingerprinting & dedup, severity derivation, report merge, HTML report (uPlot, Cytoscape), deterministic cross-report summary (`sw analyze`).

**Accept**: every number in a summary is counted from the input reports; the same reports give the same summary. No secrets in reports (redaction tests).

## Phase 7 — Telemetry & System Model (0.7)

Build: OTLP file/receiver ingestion, Prometheus scrape, span-tree → graph, critical path, entity resolution (union-find), model snapshots & diff, correlation of perf results with spans.

**Accept**: model merges code-, config- and trace-derived nodes for the fixture into the correct entities. Every edge lists its evidence sources.

## Phase 8 — Reliability Lab (0.8)

Build: built-in TCP/HTTP fault proxy, Toxiproxy & Docker injectors, cleanup stack + TTL watchdog, scenario catalogue, steady-state hypotheses, recovery time, retry amplification, isolation analysis.

**Accept**: no fault persists after crash/kill tests. Retry storm and missing-breaker fixtures are detected. Unrelated routes stay unaffected in the isolation test.

## Phase 9 — What-If & Evolution (0.9)

Build: experiment DSL, interleaved design, bootstrap/MWU/Cliff/Holm comparison, A/A noise floor, git worktree isolation, install cache, Docker sandbox, Pareto ranking, human review report.

**Accept**: detects the known-better query candidate with CI excluding 0. Rejects a candidate that breaks a test. The user's working tree is untouched (checksum before/after).

## Phase 10 — Adversarial Agent (0.10)

Build: heuristic planner, bandit selection, scenario DSL + validator, coverage bitsets, novelty dedup, budgets, test export.

**Accept**: finds ≥ 1 seeded defect not covered by the configured suite. Zero safety-validator bypasses in a fuzzed proposal test.

## Phase 11 — 1.0 Hardening

Docs site (from this folder), GitHub Action, multi-arch Docker image, SEA binaries (optional), API freeze, schema v1 freeze, migration tests, security review, performance budget sign-off.

## Later / backlog

gRPC, WebSocket, GraphQL executors · HTTP/3 · Playwright browser scenarios · distributed load generation (multiple machines, coordinator + agents, histogram merge) · Kubernetes fault injector · Python/Go/Java inspectors via tree-sitter · team history server & web UI · VS Code extension (show findings inline via SARIF) · DDSketch adapter · PELT change-points.
