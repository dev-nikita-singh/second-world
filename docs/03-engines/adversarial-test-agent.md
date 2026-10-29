# Adversarial Test Agent

> Generates **new** test scenarios beyond fixed suites. It is a bounded, fully deterministic search loop: a heuristic planner plus a bandit, with no AI.

## 1. Heuristic planner

| Planner | How it proposes scenarios |
|---|---|
| **Heuristic** (the only planner) | Coverage gaps (untested status codes, params, state transitions), mutation of previous failures, architecture risks (e.g. ARCH001 → slow-dependency test), idempotency keys detected in the contract |

The planner produces `ScenarioProposal` objects as data (DSL, validated by a Zod schema), never code. Given the same seed and inputs, it proposes the same scenarios.

## 2. Bounded loop

```text
collect context ─► pick area (bandit) ─► hypothesis ─► concrete scenario (DSL)
     ▲                                                     │
     │                                    validate: schema + Safety Guard + budget
     │                                                     │ (reject → log reason)
 update scores ◄── record evidence ◄── assert ◄── execute in approved env
```

Termination conditions: iteration budget, request budget, time budget, no new information for `k` rounds, or user cancel.

## 3. Algorithms

- **Area selection = multi-armed bandit** ([DSA §8.1](../04-data-structures-and-algorithms.md#81-multi-armed-bandit-ucb1--thompson-sampling)). Each "arm" is an endpoint × technique pair. The reward is new findings or new coverage. UCB1 by default, Thompson sampling optional. This balances exploiting buggy areas against exploring untested ones.
- **Coverage tracking**: bitsets over (operation, status code, schema branch, state transition).
- **Novelty**: scenario fingerprints (normalised hash). Duplicates are skipped via a `Set` (or a Bloom filter for very long runs).
- **Minimisation**: failing scenarios go through fast-check shrinking and ddmin before being reported.

## 4. Scenario DSL (what the agent may produce)

```ts
const ScenarioSchema = z.object({
  title: z.string(), hypothesis: z.string(),
  setup: z.array(StepSchema).max(10),
  steps: z.array(StepSchema).min(1).max(50),
  parallel: z.object({ copies: z.number().int().min(2).max(50) }).optional(),
  assertions: z.array(AssertionSchema).min(1),      // must be explicit
  expectedClassification: z.enum(["defect", "contract-gap"]),
});
```

Steps may only reference operations in the contract and hosts on the allow-list. No shell, no file system, no arbitrary code.

## 5. Safety validator (runs before every execution)

Rejects: unknown hosts, methods not permitted in the environment, payloads above the size limit, `copies` above the concurrency limit, anything touching non-test accounts, and destructive operations without approval. Every rejection is logged to the audit trail.

## 6. Output

New findings (with full reproduction), new coverage %, a list of tried hypotheses with outcomes (including "not reproduced"), budget spent, and suggested tests to add permanently to the user's suite (exported as Vitest/Jest or `sw` config).
