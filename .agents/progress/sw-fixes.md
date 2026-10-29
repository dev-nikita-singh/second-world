# sw-fixes progress (wave 5)

## Done
- Fix 1 (bugs artifact paths): src/cli/commands/bugs.ts `relocateArtifacts()` rewrites result.artifacts,
  findings[].reproduction.artifacts, findings[].evidence[].artifact after pending-<ulid> → <runId> rename.
  Tests: tests/integration/bugs/cli-replay.test.ts (every referenced path exists in stdout + report.json; failed before),
  tests/unit/cli/bugs.test.ts relocateArtifacts unit. Agent: writes no artifacts (artifacts: []), no rename → not affected.

- Fix 2 (gzip OTLP): new src/adapters/telemetry/gzip.ts (maybeGunzip: magic 1f 8b, cap min(256 MiB, max(16 MiB, 200x compressed)),
  GzipLimitError); build.ts gunzips before isOtlpProtobufFile (with .gz stripped from the name). Tests: tests/unit/model/otlp-gzip.test.ts (6).

- Fix 3 (exact perf.tick p95/p99): new src/engines/performance/tick-merge.ts (TickWindowMerger); worker.ts sends
  newest closed window histogram once per window (tick.window); sharded.ts merges newest window all live workers closed.
  Docs: performance-lab.md §workers. Tests: tests/unit/performance/tick-merge.test.ts (4),
  tests/integration/performance/workers-tick.test.ts (1; failed before: p95 was max).

## Status: DONE
- Final: vitest unit + integration/{performance,bugs,model}: 113 files, 1173 passed; tsc clean; biome clean on my lines
  (bugs.ts / tests/unit/cli/bugs.test.ts have pre-existing format diffs not touched).
