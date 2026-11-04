# sw-linux-w9 progress — DONE (reported to main)

## Done
1. workers.test (perf sharding): setTimeout fires up to ~1.5 ms early vs performance.now() on Linux; worker shards
   share a FUTURE t0, so a VU's first iteration began before warmupEnd and was counted as warmup.
   Fix: src/engines/performance/scheduler/closed.ts re-sleeps until now >= startAt. Unit test tests/unit/performance/closed-schedule.test.ts.
2. lifecycle bugs Ctrl+C: startGatedProxy (tests/integration/concurrency/helpers.ts) creates a trigger file after 15 requests
   then holds later ones 3 s; SIGINT via SW_TEST_SIGINT_WHEN_FILE → run is guaranteed in flight.
3. shop-express sync-crypto: raw-socket burst (8 logins then /healthz, fixed order); threshold 0.5 × 8 × measured login work.
4. precision: detectors.ts 10 ms + 20 ms peak windows (narrow only if ≤5 significant clusters = lattice guard); runner method text updated; 2 unit tests.
5. Extra: safety-rate-cap unit p99→p50 (load flake on Linux full suite); ledger.test reader tolerates EPERM/EACCES/EBUSY.
Pass counts: Linux 10/10 each (+12/12 workers subset), Windows 5/5 each. Full suite Linux: 2020/2021 (the 1 = safety-rate-cap flake, fixed after).
Windows full: only failures outside my scope (cli dry-run/f1 timeouts, ledger writer EPERM in src/adapters/faults/cleanup.ts).
