# Progress: sw-agent

## Done (written, NOT yet type-checked or tested)
- `src/engines/agent/scenario.ts`: strict Zod ScenarioSchema (§4): title, hypothesis, setup ≤10, steps 1..50 by contract operation key, optional parallel {copies 2..50, step?}, explicit assertions ≥1 (status, status-class, no-5xx, same-json, copies-agree, max-success, json, max-duration, schema-valid; optional `rule`), expectedClassification. No URL/host/shell/fs/code fields. Also requestCount, canonicalJson, scenarioFingerprint, parseScenario.
- `src/engines/agent/safety.ts`: validateProposal(raw, policy, audit, source). Checks: raw pre-flight (size, depth, plain JSON), schema, unknown operations, path traversal in path params, foreign hosts in values, roles limited to configured test accounts, credential/routing headers denied, CR/LF, mutations gate, destructive ops need approval, copies ≤ limit, remaining request budget, undefined {{vars}}. Every rejection is audited as `agent.scenario.rejected`.
- `src/engines/agent/bandit.ts`: UCB1 (tries untried arms first) and seeded Thompson (Beta via Marsaglia–Tsang).
- `src/engines/agent/coverage.ts`: growable Bitset CoverageTracker (status/branch/param/trans), BloomFilter, NoveltySet.
- `src/engines/agent/execute.ts`: Scenario → bugs BugCase (`toBugCase`), runs through bugs `runCase` on a bugs Session, splits exchanges per step, records coverage, evaluates assertions, and builds failure fingerprints. A timeout counts as a failure for max-duration assertions.
- `src/engines/agent/schema.ts`: AgentInputSchema (bugs target/openapi/auth/hooks/values, planner, bandit, techniques, budget {maxIterations, maxRequests, maxDuration, patience}, replays, minimize, maxCopies, context.results, regression, llm budget).

## Session 2 log
- Step 1 DONE: tsc clean (fixed BloomFilter paren syntax error; fixed CoverageTracker growth bug: bitset read before interning replaced it). tests/unit/agent/{fixtures.ts, core.test.ts}: 30 tests pass (scenario schema, safety rules, bandit UCB1/Thompson, coverage/bloom).

- Step 2 DONE: tests/unit/agent/validator.property.test.ts (3 props: 2000 random proposals with an independent oracle — unknown ops, foreign hosts, traversal in path params, copies > limit, unconfigured roles, mutations/destructive without permission, budget — 0 violating proposals accepted, all clean ones accepted; unknown-key injection ×500 rejected; arbitrary JSON ×1000 rejected).

- Step 3 DONE: planner/types.ts (Arm, Planner, PlanState), context.ts (extractHistory from bugs reproductions / agent scenarios, scenarioFromBugCase, extractArchHints ARCH0xx → ops), planner/heuristic.ts (status-gap, param-gap, boundary, idempotency(+concurrent), ownership, privilege, lifecycle, concurrency, history, arch-risk). Fixed a dangling-else in archOps. tests/unit/agent/heuristic.test.ts: 14 tests. Total unit 47.

- Step 4 DONE: engine.ts (executeAgent: AgentInput → BugsInput session; bandit over planner arms; validate (audited) → novelty → reset → executeScenario → coverage; new failure → replay ×replays (extend to maxReplays if flaky) + classifyReplays; ddmin over setup + unreferenced steps (empty set tried first); stop on iterations/requests/time/patience/cancel/arms-exhausted/LLM cost; rejected proposals deduped by raw hash; AgentData), index.ts (agentEngine, runAgent, parseAgentInput, AgentData; llm planner lazy-imported), export.ts (suggestedTest: Vitest file + sw config snippet). tests/unit/agent/{mock-session.ts (MiniShop behind real BugsHttp + lease, fake executor), engine.test.ts (11)}. Unit total 58.
- Observation-only rules (never defects): agent/accepts-invalid-input, agent/slow-response, bugs/undocumented-status, and any scenario with expectedClassification "contract-gap".

- Step 5 DONE: tests/unit/agent/export.test.ts (3): every emitted Vitest file + config snippet has 0 TS syntax diagnostics; emitted tests are transpiled and executed against a node:http MiniShop: they FAIL on the defective app and PASS on the fixed app; hostile titles/values stay string literals (AST check). Unit total 61.

- Step 6 DONE: planner/llm.ts (LlmPlanner: heuristic arms; per-arm prompt = redacted contract slice + role NAMES + coverage gaps + earlier outcomes in nonce data blocks; responseSchema submit_scenarios; extractJson + one retry; per-arm batch cache, ≤2 calls/arm; ceilings maxCalls/maxTokens/maxCostUsd → LlmBudgetExhausted → stopReason "cost" + AGENT_LLM_BUDGET; createLlmPlanner from ai config + agent.llm overrides, injectable provider). tests/unit/agent/llm.test.ts (6): valid run; schema-invalid / foreign host / unconfigured role / unknown op rejected (source llm); no credentials in prompt; malformed → retry; call and cost ceilings; ConfigError without provider. Unit total 67.

- Step 7 DONE: tests/integration/agent/{helpers.ts (counting proxy, matchedDefects), shop-express.test.ts (4, ~7 s), shop-fastify.test.ts (2, ~1 s)}. shop-express: baseline (bugs, contract technique only) = schema-drift-price; agent confirms bola-orders, idempotency-ignored, boundary-500 (3 beyond baseline, 3/3 replays each), 36 iterations / 86 requests / coverage 70 %; pinned-regression replay reproduces; budget 40 → server-side count == used ≤ 40, stop "requests". shop-fastify: correct-by-design (idempotency-honoured, ownership, stock-atomic, qty-validated) not reported; seeded bfla-delete-product, boundary-500-limit, schema-drift-created-at confirmed. New rule agent/idempotency-key-race (concurrent duplicates with one key): reproduces on BOTH apps (fastify's check-then-await-then-insert is not atomic) — real, unseeded; reported to main for ground truth.
- biome clean on my paths; tsc clean.

- Step 8 DONE: CONTRACTS.md "sw-agent" section (READY) with CLI wiring + reporting notes; request about the shop-fastify concurrent idempotency race appended under Requests; main messaged.

## Status: DONE (all 8 steps). Tests: 67 unit (tests/unit/agent: core 30, validator.property 3, heuristic 14, engine 11, export 3, llm 6) + 6 integration (shop-express 4, shop-fastify 2; ~8 s total). tsc clean repo-wide; full unit project 994/994; biome clean on my paths.

## In progress
- none

## Next (gaps / optional follow-ups)
- stock-race (bugs/race-lost-update) not found: needs knowledge of a low-stock item (the agent has no max-success invariant source; bugs gets it from config.concurrency). Could read bugs `concurrency[]` from config or harvest stock from GET responses.
- History re-check of bugs concurrency cases maps to no-5xx only (linearizability invariants are not expressible in the DSL).
- LLM planner not tested against a real provider (mock only, by design); evidence is a per-arm contract slice, not the sw-ai evidence pack.
- Suggested tests: schema-valid assertions are emitted as required-key/primitive-type checks (no Ajv in user projects).
- CLI wiring (`sw agent`) and reporting blocks belong to sw-core / sw-examples (notes in CONTRACTS).

## Decisions
- Execution reuses bugs internals by direct import: `session.ts` (openSession), `cases.ts` (runCase, conformance), `http.ts`. Bugs' `executeBugs` is not changed.
- Failing scenarios are classified with bugs `classifyReplays`. Minimisation will use bugs `ddmin` over the steps that no assertion references.
- Agent failure fingerprint = fingerprint(["agent", rule, operation, pointer]) (session 2: assertion kind dropped so sequential + concurrent duplicate-submit failures dedupe into one finding).

## Blockers / requests
- none (session 2 resumed with the narrowed QA brief)
