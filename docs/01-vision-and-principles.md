# 01 — Vision & Principles

## 1. What SECOND WORLD is

A **software experimentation engine**. Instead of only saying "your app is slow", it helps the developer:

1. **Observe**: measure latency, throughput, errors and resources under controlled load.
2. **Model**: build a graph of components and dependencies from code, specs and telemetry.
3. **Reproduce**: turn suspicions into deterministic, replayable failing scenarios.
4. **Hypothesise**: propose causes with deterministic heuristics and rules, each linked to evidence.
5. **Experiment**: change one variable, re-measure, and compare against a baseline with statistics.
6. **Verify & remember**: store the outcome, detect regressions over time.

This loop is called the **investigation loop**:

```text
   ┌────────► Observe ──► Model ──► Reproduce ──┐
   │                                            ▼
 Remember ◄── Verify ◄── Experiment ◄── Hypothesise
```

## 2. What it is not

- Not just a load tester (k6, Artillery, autocannon already exist, and we may embed them).
- Not just a static analyser or linter.
- Not an autonomous code-rewriting bot. Humans approve every change.
- Not an AI tool. SECOND WORLD is **fully deterministic**: no AI or LLM is used anywhere, and every result comes from measurement, analysis or code.
- Not a production chaos platform. Disruptive actions are opt-in and isolated by default.

## 3. Target users & environments

| User | Typical use |
|---|---|
| Backend developer | Local load test + architecture map before a PR |
| QA / SDET | Contract, boundary, property and concurrency tests against staging |
| SRE / platform | Capacity curves, fault injection in isolated environments |
| Tech lead | Compare candidate fixes, track regressions in CI |
| CI pipeline | Non-interactive runs, machine-readable reports, exit codes |

It MUST run on **Windows, macOS and Linux**, inside **Docker/Kubernetes**, in **CI runners**, in **air-gapped/offline** networks, and behind **corporate proxies**. See [06 – Environments](06-environments-and-portability.md).

## 4. Design principles (non-negotiable)

| # | Principle | What it means in practice |
|---|---|---|
| P1 | **Modular & independent** | Each engine works alone with only its own required inputs. |
| P2 | **Evidence first** | Every finding carries typed evidence and a source (measurement, code location, trace, comparison). |
| P3 | **Honest classification** | Observation ≠ threshold breach ≠ reproduced defect ≠ suspected risk ≠ hypothesis. |
| P4 | **Deterministic, no AI** | Seeded randomness, monotonic clocks, documented statistical methods, reproducible configs. No AI or LLM is used anywhere: every result comes from measurement, analysis or code. |
| P5 | **Safe by default** | Localhost/allow-listed targets only, hard request budgets, instant cancel, no code execution during static analysis. |
| P6 | **Graceful degradation** | Missing capability (no Docker, no telemetry, no git) → feature disabled with an explanation, never a crash. |
| P7 | **Portable** | Pure JS/WASM dependencies, no native addons in the core, OS-neutral paths/signals/line endings. |
| P8 | **Dynamic & extensible** | Engines, rules, assertions, reporters, storage backends and fault injectors are plugins behind stable interfaces. |
| P9 | **Lean** | Lazy-load heavy modules (TypeScript compiler, Playwright). Bounded memory regardless of test length. |
| P10 | **Explain limits** | Every report has a "What we could not determine" section. |

## 5. Finding classification (the trust ladder)

All engines MUST use exactly these levels. From weakest to strongest:

| Level | Name | Produced by | Example |
|---|---|---|---|
| L0 | `hypothesis` | Heuristics (System Model inference, Agent planner) | "Latency may come from N+1 queries in `OrderRepo`" |
| L1 | `suspected-risk` | Static rules | "Outbound `fetch` without timeout at `pay.ts:42`" |
| L2 | `observation` | Any measurement | "p99 = 840 ms at 100 VUs" |
| L3 | `threshold-breach` | Threshold evaluator | "p99 840 ms > budget 500 ms" |
| L4 | `reproduced-defect` | Bug Hunter / Agent with replay | "Duplicate order with same idempotency key, 5/5 replays" |
| L5 | `verified-fix` | Evolution Engine | "Candidate B: p95 −38 % (95 % CI −41…−34 %), all tests pass" |

A finding can only be **promoted** (e.g. L1 → L4) by new evidence; a hypothesis never promotes a finding by itself.

## 6. Success definition

SECOND WORLD succeeds when a developer can go from "something feels slow/broken" to "here is a reproduced cause and a verified, measured improvement" faster and more reliably than with separate tools, and can trust every number in the report.
