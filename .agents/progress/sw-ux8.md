# sw-ux8 progress (wave 7b)

## Done
- T1 dry-run validation. Test tests/unit/cli/dry-run-validation.test.ts: 7/8 failed before (all bad inputs printed
  "config valid", exit 0), 9/9 pass after. Fix: performance parse validates thresholds (section-prefixed);
  stress parse validates base thresholds; new exports checkPerformancePlan (compilePlan) and checkReliabilityInput
  (scenario / maxDuration / steadyState+hypothesis) called by perf/stress/reliability --dry-run; reliability
  dry-run also rejects an undeclared dependency.
- T2 engine input error paths. Test tests/unit/cli/engine-input-errors.test.ts (7 pass). Before: old
  parsePerformanceInput printed `(root): Unrecognized key: "duraton"` and accepted "p95 < banana" (scratch run).
  loader.ts: new zodIssueLines({prefix, schema}) + inConfigSection (main approved); zodToConfigError uses it.
  5 engine index parse fns use it (codes unchanged). details.issues now {path,message}[].

- T3 tests/unit/reporting/large-series.test.ts: 3/3 RangeError before, pass after (blocks.ts finiteRange loop,
  used in tty/markdown/html). Other spreads checked: performance/sharded.ts:419, shard.ts:433 are per-worker (bounded).
- T5 tests/unit/reporting/perf-errors.test.ts: tty/md/html failed ("• status: 250"), pass after. blocks.ts
  perfErrorKindLabel -> "status (HTTP 404, 500)" from firstErrors+errorSamples; markdown perf now has an errors table.
- T6 tests/unit/reporting/reliability-isolation-wording.test.ts: 3/3 failed, pass after; reliability.ts
  isolationVerdict; tests/unit/reporting/reliability.test.ts:147 updated to new wording.

- T4 tests/unit/cli/init-openapi.test.ts: 7/7 failed before, pass after. init.ts contractHints (servers[0]
  w/ variables, relative -> default origin, remote -> default origin + path + note; first anonymous GET w/o
  required params, health-like paths only as fallback + used as health). Manual: conduit copy -> init -> perf
  against conduit on 3100: 150 req, 0% errors (p95 threshold breach is real latency).

- T7 tests/unit/cli/docs-config-examples.test.ts: docs/08:41 failed (stress.stopWhen.errorRate string) -> fixed
  docs/08:95 to 0.05. 7 blocks validated with loadConfig + builders + parse*Input (+checkPerformancePlan /
  checkReliabilityInput): docs/08:41, 09:119, quickstart:99, 03 agent:18, bug-hunter:83, perf-lab:98,
  reliability:75. 6 skipped with reason (SKIP map). tests/unit/cli/docs-architecture.test.ts: both tests fail
  on HEAD docs/02, pass now (tree paths exist; §4.3 event list == emitted). docs/02 §2 layering table,
  §3 tree, §4.3 events rewritten; §4.6 (sw-race7) untouched; docs/11 untouched.
- Also fixed pre-existing lint in my lane: reporting/tty.ts:310, reporting/reliability.ts:181,
  tests/unit/reporting/reliability.test.ts:347.
- Final: tests/unit + tests/integration/cli 154 files / 1551 passed; tests/e2e/cli 11 passed 1 skipped;
  integration perf/stress/reliability/bugs/agent 26 files / 91 passed; tsc clean; biome clean on my files.

## Status: DONE

## Notes
- Bash tool unescapes `\\n` inside heredocs: write escapes via chr(92) in python.
