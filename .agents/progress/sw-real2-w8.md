# sw-real2-w8 progress (wave 8)

## Done
- (start) read plans, conduit conventions, engine rule ids.

## In progress
- Unit 1: inspect node:http route detection (src/engines/architecture/analyzer/ts/extractors/node-http.ts).

## Next
- Unit 2: examples/orders-jobs-api (app + in-example provider fake + openapi + sw.config.ts + expected-findings).
- Unit 3: tests/system/orders-jobs.test.ts (+ helpers), packed journey opt-in.

## Decisions
- Defects (planned): retry fixed delay no jitter (worker), no timeout on sync charge refresh, webhook replay
  not idempotent, unbounded job queue (no backpressure), stale order cache after PATCH.

## Checkpoint 2 (06:40)
- Unit 1 DONE: node-http extractor (src/engines/architecture/analyzer/ts/extractors/node-http.ts), FRAMEWORK_IDS +node-http,
  ARCH007 groups past /api|/v1 prefix + optional-auth handlers public + credential-issuing calls not guards, ARCH008
  collapses heuristic repository datastores. tests/unit/architecture/node-http-routes.test.ts (20). coverage-gaps fixture
  changed to a runtime-built table. Conduit inspect: 22 routes, ARCH005 x3 only (titles name GET /api/articles).
  shop-express 5/5, shop-fastify 3/3 precision 1.0 (integration inspect tests).
- main's bugs: (1) createProgram RangeError → retry noResolve + ARCH_NO_RESOLVE (tests/unit/architecture/large-repo.test.ts,
  2000 files: before exit 70, after exit 0/200 routes ~12 s). (2) hashing bounded parallel 16: 8000 files 5.4-5.9 s → 1.2-1.5 s.
- Unit 2 in progress: examples/orders-jobs-api written (src/, provider/, openapi.yaml, sw.config.ts); inspect finds ARCH001+ARCH002.

## Checkpoint 3 (06:53)
- Unit 2/3: examples/orders-jobs-api built (src/, provider/ fake PSP with webhooks, openapi.yaml, sw.config.ts,
  expected-findings.json sync --check ok). tests/system/orders-jobs.test.ts + orders-jobs/helpers.ts: 11 passed / 1 skipped
  (pack, SW_SYSTEM_PACK=1), 66 s. Recall/precision 1.0 for inspect 2/2, bugs 2/2, agent 1/1, perf 0/0, stress 1/1,
  reliability 5xx 1/1, timeout 1/1.
- Next: README, run requested suites, SW_SYSTEM_PACK=1 run, report gaps to main.
