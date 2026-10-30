# Progress: sw-bugs6

## Done (all units; nothing in progress)
- Unit 1 HAR timings: src/engines/bugs/http.ts BugsHttp uses executor `timing: "detailed"` (+ onConnection, bounded 128 pending conns); Exchange.phases {waitMs,serverMs,transferMs,dns/tcp/tlsMs?}; a new connection is attributed to the first request whose [tStart, tSent] window contains its ready time (approximate under bursts). src/engines/bugs/har.ts harTimings(): blocked/dns/connect(incl ssl)/ssl/send(0)/wait/receive, -1 n/a, blocked = remainder so sum = time; no phases → wait = time, others -1. Tests: unit har (6), validator checks timings (ssl ⊂ connect, required ≥ 0, sum ≈ time), mixed-race integration asserts timings.
- Unit 2 `--mix`: src/cli/commands/bugs.ts parseMix + MIX_FORM; bugsInputFromFlags attaches mix to every --concurrency-test; `--mix` w/o --concurrency-test → SW_CONFIG_FLAG. src/cli/main.ts option registered (collect). Tests: tests/unit/cli/bugs-mix.test.ts (9, incl. subprocess --dry-run --json and exit 2), tests/integration/bugs/cli-mix.test.ts (2: racy server → race-lost-update reproduced exit 1 + HAR; atomic control → exit 0).
- Docs: docs/03-engines/api-bug-hunter.md (--mix table + example; HAR timings paragraph).
- Verified: `npx vitest run tests/unit/bugs tests/unit/cli tests/integration/bugs` 27 files / 229 tests green; tsc 0 errors; recall/precision 1.00 on both shops unchanged.

## Gaps
- Main burst of a CLI concurrency test still has no path/query params flag (only --body/--role); config needed for e.g. `PUT /products/{id}/stock` as the main op (it can be a --mix entry though).
- HAR `send` always 0 (undici has no request-written event).
