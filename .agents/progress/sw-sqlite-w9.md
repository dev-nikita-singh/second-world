# sw-sqlite-w9 progress — DONE (2026-11-04)

## Done
- src/engines/history/store.ts (new): HistoryStore contract (backend: string), HistoryError (+SW_HISTORY_BACKEND), shared pure helpers (prepareRun, matches/selectEntries, resolveIn, trendOver/resolveTrendMetric, planPrune, isIndexEntry)
- jsonl-store.ts refactored onto store.ts (behaviour unchanged; re-exports HistoryError/HistoryStore/isIndexEntry); verify adds backend:"jsonl"
- sqlite-load.ts (lazy import, drops ONLY node:sqlite's ExperimentalWarning while loading), sqlite-store.ts (WAL, busy_timeout, BEGIN IMMEDIATE, schema v1 + schema_migrations + user_version, JSONL import idempotent per id + signature, verify incl. quick_check, exportSqliteHistoryToJsonl, cached connection closed after 50 ms idle / close())
- registry.ts: registerHistoryBackend/getHistoryBackend/listHistoryBackends (plugin stores)
- index.ts: createHistoryStore sync + lazy wrapper for sqlite/plugin backends (ready(), close(), fallbackReason), openHistoryStore; JSONL fallback with onWarning when node:sqlite unavailable
- types.ts: VerifyIssue "db-integrity", VerifyReport.backend?
- tests: unit/history/contract.ts (shared suite, exportable), contract.test.ts (jsonl, sqlite, lazy sqlite, parity), sqlite.test.ts; integration/history/sqlite.test.ts (+ fixtures/sqlite-writer.ts), sqlite-bench.test.ts (SW_BENCH=1). unit+integration history: 74 pass, 1 skipped (bench), 3x
- docs: evidence-and-history.md §B.1 rows, §B.1.1 + 10k numbers, §B.3 sentence; docs/02 ADR 008 row; docs/17 sqlite line
- CONTRACTS.md section "sw-sqlite-w9" READY; messages.log

## Next
- none (main: commit; optional follow-ups in final report)
