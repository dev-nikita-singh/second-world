# sw-coverage progress (Wave 5) — DONE
Owns: new files tests/unit/**/*.coverage.test.ts (15 files, 206 tests), this file. No src edits.
Coverage (unit project): lines 81.40 → 84.11, branches 67.38 → 70.91. Unit+integration baseline: L 88.18 / B 74.03 (18-min run, not repeated).
Unit suite: 120 files / 1342 tests green; tsc clean.
## Bugs reported (all FIXED by main; tests flipped from it.fails to regular regression tests)
- guard: hex IPv4-mapped IPv6 classified public (529d668)
- redact: camelCase sensitive keys not redacted (0e10afe)
- agent export: U+2028/2029 escaped the // header comment → code injection
- summary: unknown severity ranked above critical
## Remaining risky gaps (not covered)
- adapters/faults/builtin-proxy.ts, toxiproxy.ts, docker.ts, external.ts (owned and being edited by sw-reliability)
- engines/performance/worker.ts + sharded.ts (worker_threads; v8 coverage doesn't see workers), telemetry/receiver.ts, http/phase-timing.ts
- bugs engine/property/session/generate (integration-only), cli commands (model/history/config/run-common)
- core/probe/probe.ts, cleanup.ts signal handlers/crash path (process-level)
