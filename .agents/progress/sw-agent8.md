# sw-agent8 progress (wave 7b)

## Plan
1. agent `resources` input (ResourceSchema) → HeuristicPlanner deriveResources(contract, input.resources). world.ts change → main.
2. ownership per secured op (read/update/delete), not read only.
3. Dictionary: harvest contract path-param names (slug, username, *Id) incl. wrapped objects; path-only use.
4. race finding attributed to mutating mix op when primary is a read (cases.ts evalConcurrency).

## Done
- Task 1+2: test tests/integration/agent/ownership-resources.test.ts (blog server, wrapped {article:{slug}}, public GET, owner-only DELETE).
  Before: all 3 fail "Unrecognized key: resources"; after schema+planner only: FP "Cross-account read on GET" (2 fail). After fix: 3/3 pass.
  Files: src/engines/agent/schema.ts (resources: ResourceSchema[] optional), engine.ts (pass to planner), planner/heuristic.ts (deriveResources(contract, resources); ownershipOps = secured read/update/delete).
  world.ts change for main: buildAgentInput forward bugs.stateful.resources → agent `resources` (not sent yet).

- main asked: world-path e2e test marked it.fails → "agent: resources through the config/world path (bugs.stateful.resources only) > buildAgentInput forwards bugs.stateful.resources: bola on DELETE, no unresolved {{rid}}" (same file). Verified it passes when input.resources is injected (temp copy, deleted).
- Task 3: tests/unit/agent/dictionary-harvest.test.ts: before 5 fail/3 pass, after 8/8. dictionary.ts (pathValues map, path-only lookup when path has {name}; iterative harvest ≤500 nodes; pathParamNames(contract) WeakMap) + cases.ts harvest passes names. Decision: configured values DO apply to body (documented "parameter/property name"); harvested non-id names are path-only.
- Task 4: tests/integration/agent/race-attribution.test.ts: before affected GET /products/{id} (fail), after POST /orders + replay reproduces (2/2). cases.ts raceOperation(). NOTE conduit expected-findings detectedBy.operation for favorites-count-race says GET → must become POST /api/articles/{slug}/favorite (main, examples not mine).

- main applied world.ts line; world-path test flipped to `it`: ownership-resources.test.ts 4/4.
- Docs: adversarial-test-agent.md §1 (resources, secured-only ownership), api-bug-hunter.md (values + harvest; race attribution).
- Verification: tests/integration/{agent,bugs} 11 files 40 tests pass; examples+shop system 15 files 107 tests (2 failures: .second-world dir created by MY manual sw run in examples/conduit-api, removed → rerun pass; calibrated timing flake → rerun pass). tests/unit 1515 pass, 7 fail only in sw-ux8's tests/unit/cli/init-openapi.test.ts (in progress). biome clean on my files; tsc clean on my files (other agents' in-progress errors).
- conduit: bugs 4 TP findings, race now on POST .../favorite (ground truth still says GET → scored miss+FP); agent 1 finding bugs/bola DELETE /api/articles/{slug} = planted delete-article-no-ownership (truth has no "sw agent" detectedBy → test exits-0 assertion fails). Needs main: expected-findings.json + conduit.test.ts update.

## Status: DONE
