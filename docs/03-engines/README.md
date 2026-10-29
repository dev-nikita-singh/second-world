# 03 — Engines Catalogue

Every engine is an independent module that implements the `Engine` contract ([02 – Architecture §4](../02-architecture.md#4-key-core-abstractions)). No engine uses AI: every result comes from measurement, analysis or code.

| Engine | Doc | Primary question | Required inputs | Optional inputs |
|---|---|---|---|---|
| Performance Lab | [performance-lab.md](performance-lab.md) | How fast/stable is it under *this* load? | target URL, requests | auth, data files, telemetry |
| Stress & Capacity Lab | [stress-capacity-lab.md](stress-capacity-lab.md) | Where do requirements break as load grows? | target, stages, thresholds | telemetry |
| Architecture Inspector | [architecture-inspector.md](architecture-inspector.md) | What is the structure and where are the risks? | repo path | tsconfig, framework hints |
| API Bug Hunter | [api-bug-hunter.md](api-bug-hunter.md) | Does the API keep its contract? | target, contract (OpenAPI or assertions) | test accounts, reset hook |
| Adversarial Test Agent | [adversarial-test-agent.md](adversarial-test-agent.md) | What tests are we *missing*? | target, contract, safety policy | arch graph, history |
| Reliability Lab | [reliability-lab.md](reliability-lab.md) | What happens when a dependency misbehaves? | target, isolated env, fault injector | telemetry |
| System Model | [system-model.md](system-model.md) | What is the system, as evidence shows it? | ≥1 evidence source | all others |
| What-If Engine | [experiments.md](experiments.md#part-a--what-if-engine) | Does change X improve metric Y? | baseline + variant + workload | — |
| Evolution Engine | [experiments.md](experiments.md#part-b--evolution-engine) | Which candidate fix is best and safe? | repo (git), baseline, candidates, test cmd | — |
| Summary (`sw analyze`) | [evidence-and-history.md](evidence-and-history.md#a4-report-structure) | What do several reports say together? | ≥1 report (or `--last`) | — |
| Evidence & Reporting | [evidence-and-history.md](evidence-and-history.md#part-a--evidence--reporting-engine) | What do we know, at what confidence? | ≥1 engine result | — |
| Experiment History | [evidence-and-history.md](evidence-and-history.md#part-b--experiment-history) | Did it get better or worse over time? | storage dir | — |

## Capability requirements

Before running, the registry checks each engine's `requires` against the [environment probe](../06-environments-and-portability.md#3-environment-probe-sw-doctor). Missing **required** capabilities give an exit-4 error with a hint. Missing **optional** capabilities switch off sub-features and add a `Limitation` to the report.

| Capability | Perf | Stress | Arch | Bugs | Agent | Rel | Model | WhatIf | Evo |
|---|---|---|---|---|---|---|---|---|---|
| `network.target` reachable | R | R | – | R | R | R | o | R | R |
| `fs.read` repo | o | – | R | o | o | – | o | o | R |
| `git` binary | – | – | o | – | – | – | – | – | R |
| `docker` / container runtime | – | – | – | o | o | o | – | o | o |
| `toxiproxy` or in-process proxy | – | – | – | – | – | R* | – | o | – |
| `telemetry.otlp` | o | o | – | – | o | o | o | o | o |
| `approval.disruptive` | – | o | – | o | R | R | – | o | R |

R = required, o = optional (enriches), – = unused. *Reliability Lab falls back to the built-in in-process TCP proxy when Toxiproxy is absent.

## Common output shape

Each engine returns an `EngineResult` with `findings[]`, `limitations[]`, and `artifacts[]`. It also returns an engine-specific `data` payload (e.g. `PerformanceData` with per-endpoint histograms). All payloads are versioned (`schemaVersion`) and validated before being written.
