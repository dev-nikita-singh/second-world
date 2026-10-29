# sw-docs progress (Wave 4: remove AI from docs) — DONE

## Done
- Deleted docs/03-engines/ai-analyst.md.
- Scrubbed AI/LLM/provider/prompt/token-cost mentions from: docs/01, 02, 03-engines/{README, adversarial-test-agent, evidence-and-history, experiments, system-model}, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, docs/README.md, docs/quickstart.md, README.md.
- Principle stated in docs/01 (§2 + P4): fully deterministic, no AI/LLM anywhere. Also in README, docs/README, ADR 009, 11 §6, 14 §4.
- `sw analyze` documented (docs/09 §1 subsection, quickstart §9, README tables + 5-min quickstart). Verified against src/engines/summary + src/cli/commands/analyze.ts by running it (inspect report, --last, --top, --json, error exits = 2).
- Config: `ai:` section removed; env example now `SW_REPORT__FAIL_ON=critical` (verified with `sw config print`).
- DSA §8.2 knapsack removed (8.3 Pareto keeps its number; src/engines/experiments/pareto.ts cites §8.3).
- Engine catalogue: "Needs AI?" column and `ai.provider` capability row dropped; Summary (`sw analyze`) row added.
- .agents/CONTRACTS.md: AI lines marked "REMOVED (Wave 4: no AI)" (sw-ai section, CLI analyze/agent rows, reporting AI rows, model `ai?` evidence, agent llm planner/budget, Requests line). deterministicSummary marked MOVED to src/engines/summary. Backup: scratchpad/CONTRACTS.bak.md.
- Final grep: only intentional "no AI" statements + false positive "BullMQ" (contains "llM") in architecture-inspector.md.

## Notes / open
- quickstart §9 output for `sw analyze --last` after the reliability run is the old captured data re-rendered in the new format (could not re-run reliability: src/engines/performance/shard.js missing while sw-perf works on sharding). Same format verified live on an inspect run.
- `sw analyze --last report.json` double-counts if the file is the same run as --last (no dedup) — code behaviour, not documented as a feature.
