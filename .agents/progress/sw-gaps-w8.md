# sw-gaps-w8 progress

## Gap 1 stress ignores performance.model/rate — DONE
- Repro: tests/unit/stress/perf-model-inheritance.test.ts (2/4 failed before: loadType "vus").
- Fix: src/core/world.ts buildStressInput inherits performance.model/rate only when stress+input set none of loadType/model/rate/vus; src/engines/stress/schema.ts splitBase: explicit model wins (perf inferModel rule). Docs: docs/03-engines/stress-capacity-lab.md "Load dimension".
- After: 5/5 pass; unit stress/core/cli 559 pass.

## Gap 2 misleading STRESS-SAFETY-RATE-CAP — DONE
- Root cause: not maxConcurrency (closed lease maxConcurrency = vus 48 <= 200, never throttles) and not a miscount: the world-wide GCRA (burst ceil(500/10)=50) really delayed requests, because closed-loop VUs whose answers arrive together (long-polls / batch) send >50 back-to-back; runner marked capped on any wait.
- Repro: tests/integration/stress/safety-burst-vs-cap.test.ts (48 VUs, batch-released route; throttled>0, ~160 rps, capped=true before).
- Fix: runner.ts capped only if throttled AND peak(mean, 1s series) >= 0.8*capRps (CAP_NEAR_FRACTION); else stage.burstSmoothed + informational STRESS-SAFETY-BURST-SMOOTHED. types.ts field; docs §6.
- After: pass 3x; existing maxRps-200 capped test still passes.
## Gap 3 agent lifecycle read-after-update — DONE
- Repro: tests/integration/agent/stale-read-lifecycle.test.ts + shared server tests/integration/agent/stale-cache-server.ts (notes API, GET cache, PUT forgets invalidation). Before: 2/2 fail (no update hypothesis).
- Fix: heuristic.ts lifecycle adds readAfterUpdate scenario (setup create+read, steps update+read, same-json on changed pointer + no-5xx); exported updateBody (documented update fields only, one free-text field, schema-respecting). Unit: tests/unit/agent/update-body.test.ts. Docs adversarial-test-agent.md §1.
- After: pass; agent unit+integration 89 pass; conduit system 7 pass; conduit run: probe "passed", only finding bola DELETE (planted).
## Gap 4 bugs model-based never reaches C→R→U→R — DONE
- Root cause: fc.commands draws random lists of 5 equally weighted command kinds (<= maxCommands 8, small sizes first). Commands whose check() fails (read/update/delete before any create) are skipped, so a 4-run budget rarely holds create→read→update→read in order. Not reset or preconditions; timeLimit 8 s was not reached on the notes server.
- Repro: tests/integration/bugs/stale-read-model.test.ts (seeds 1/7/42, default runs). Before: 0 findings, e.g. "POST /notes=4, GET=3, PUT=2, DELETE=2".
- Fix: property.ts runModelTechnique runs the canonical lifecycle (create, read, update, read, delete, read-deleted) first as a fast-check example; numRuns = runs + 1.
- After: 4/4 pass. Bugs unit+integration+examples 246 pass. Conduit bugs 4/4 and agent 1/1, precision 1.00.
- orders-jobs: bugs+agent now find stale-cache-after-update (shown as FP until ground truth is updated; main told).

## Final checks — DONE
- unit 1668/1668; tsc clean; biome --error-on-warnings clean on changed files; new files LF.
- orders-jobs system 11 pass/1 skip, every engine at 1.0 after main's ground-truth update; conduit 7 pass/2 skip (bugs 4/4, agent 1/1); integration examples+agent+bugs+stress 150 pass.
- The adversarial-test-agent.md addition is kept on one line so the line-keyed SKIP in docs-config-examples.test.ts stays valid.
