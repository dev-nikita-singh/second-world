# sw-real7 progress (wave 7, Plan §C)

## Done
- examples/conduit-api: src/ (node:http router, node:sqlite Db with tx, repositories, routes, seed), openapi.yaml,
  sw.config.ts, invariants/page-size.mjs, expected-findings.json (sync --check ok), README.
- tests/system/conduit.test.ts + tests/system/conduit/helpers.ts: 7 passed / 2 skipped (pack journey, opt-in
  SW_SYSTEM_PACK=1), 83 s. tsc clean (whole repo), biome clean on my files.
- Recall/precision (with main's BOLA fix in generate.ts): sw bugs 4/4, precision 1.0; sw inspect 1/1 (3x ARCH005),
  precision 1.0; sw agent 0 findings; reliability info observation only. Overall recall 5/5.
- Packed journey (scratchpad/journey, tgz 2.5 MB / 235 files incl. 220 .map): npm init 0, npm i 0, doctor 0,
  init 0, perf(generated cfg) 1 (GET / 404s), inspect w/o typescript 4 (clear hint), with ts: inspect 0, bugs 1
  (4 TP), agent 0, perf 0, stress 0, reliability 0, model 0, analyze 0, history list 0, verify 0, cleanup 0.
- Reported to main: BOLA public-read gap (FIXED by main), agent ignores stateful.resources idPointer,
  docs/08:95 stopWhen string.

## In progress
- none (DONE). SW_SYSTEM_PACK=1 run: 2 passed, 131 s. tests/unit: 1463 passed, 3 expected fail.

## Decisions
- delete-article-no-ownership detectable (main fixed generate.ts:541 per-op secured check).
- Race detected with main op = GET read (burst 2) + 5 mix `inc` favorites by different roles (counter model).
