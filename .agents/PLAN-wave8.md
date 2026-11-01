# Wave 8 — Production readiness (plan + Definition of Done)

User (2026-11-01): keep strengthening, don't stop until production-ready. Branch `wave-8` from master
(after wave-7 merge). Same RULES as `.agents/PLAN-wave7.md` (no claim without evidence, reproduce
first, stay in lane, never commit/stash/reset/checkout, LF files, lint clean at
`--error-on-warnings`, max 4 agents). Never reformat examples/shop-*, examples/payments-fake (their
line numbers are part of the test contract; biome ignores them).

## Definition of Done for "production-ready 0.1.0" (main checks each item with evidence)

1. Full suite green **twice in a row** on Windows; `npm run lint -- --error-on-warnings` 0/0; tsc clean.
2. Every command works from the packed tarball in a clean folder (automated: `SW_SYSTEM_PACK=1`
   journey tests on conduit-api and the new wave-8 app).
3. No known open correctness bug: every finding is fixed or listed in docs/16 Known gaps with a
   reason and a user-visible workaround.
4. Security: threat model written (docs/11), fuzz tests for the Safety Guard, redaction and exported
   code, path-traversal and argument-injection checks, `npm audit --omit=dev` clean or justified.
5. Robustness of the tool itself: bounded memory on a long run (measured), large inputs (1000-op
   OpenAPI, big repo) finish with bounded time/memory, malformed inputs never exit 70.
6. Docs: every command and flag in `sw --help` is documented in docs/09 (test enforces), a
   troubleshooting guide, versioning/compatibility policy.
7. Release mechanics: version 0.1.0, CHANGELOG entry, release checklist, a publish workflow with
   npm provenance (written; it runs only when the user creates a GitHub repo and an npm token).

Out of our hands (user): GitHub repo + first CI run (Linux/macOS/podman verification), npm publish.

## Workstreams (4 agents)

### sw-cli-w8 — CLI completeness
- Concurrency main op from the CLI: path/query params (e.g. `--path-param id=1`, `--query k=v`,
  consistent with `--mix` syntax) — today `PUT /products/{id}/stock` needs a config file.
- `--dry-run` for bugs, agent, model runs the same validation as a real run (as perf/stress do).
- `sw init` interactive path tested (inject prompts/streams; no real TTY needed).
- Test that every command/option in `sw --help` (all subcommands) appears in docs/09, and vice versa.
- Owns: src/cli/** (except run-common.ts), docs/09, tests/unit/cli/** new files, tests/e2e new files.

### sw-robust-w8 — robustness of the tool
- Prove-or-dismiss sw-race7's open suspicions: PID reuse on Windows vs history lock; double Ctrl+C
  leaving temp files; shared `-o` report dir mixing runs (decide: per-run subdir or lock + doc);
  `dns.promises.lookup` without timeout in the Safety Guard; local retries without jitter.
- Soak the tool: a long perf run (≥5 min, moderate rps) with RSS sampled — growth bounded; a
  1000-operation OpenAPI through bugs/agent dry and real (time + memory); inspect of a large
  synthetic repo near maxFiles. Malformed inputs (OpenAPI, config, scenario, HAR import if any)
  → exit 2 with a message, never 70 (property-based where sensible).
- createWorld loads reporting eagerly (docs/16 gap): make it lazy if it measurably helps.
- Owns: src/core/** (except safety/guard.ts DNS part coordinate with sw-sec-w8 via main),
  src/cli/run-common.ts, src/engines/history/**, tests/unit/robust/**, tests/integration/robust/**.

### sw-sec-w8 — security review
- Threat model (assets, actors, trust boundaries, STRIDE) added to docs/11, each mitigation citing
  code + a test.
- Fuzz (fast-check is a dependency): Safety Guard URL/host/IP classification (IPv4/IPv6 forms,
  userinfo, IDN, redirects, DNS rebinding) — never allows a non-allow-listed host; redaction: no
  generated secret ever appears in tty/json/md/html/sarif/junit/HAR/curl/exported tests; exported
  agent tests never execute injected code; artifact/replay ids and `-o` paths can't escape their dir;
  child processes (hooks, evolve commands, docker) never get shell-interpreted user strings.
- `npm audit --omit=dev`; check `npm pack` contents for secrets/test data; a publish workflow
  `.github/workflows/release.yml` with npm provenance + least privilege (not runnable here).
- Owns: src/core/safety/**, src/core/log/**, src/engines/agent/export.ts, src/engines/bugs/{har,
  artifact}.ts (security fixes only), docs/11, SECURITY.md, .github/workflows/release.yml,
  tests/unit/security/**.

### sw-real2-w8 — second realistic project
- `examples/orders-jobs-api`: a different shape from conduit — background job queue + worker,
  outbound payment provider (use examples/payments-fake or an in-repo fake), webhooks with
  idempotency keys, retries, caching. Planted defects targeting engines conduit didn't exercise:
  a retry storm without backoff/jitter (reliability), a missing outbound timeout (reliability/
  inspect), webhook replay not idempotent (bugs/agent), unbounded queue growth under load (stress
  knee/saturation), a cache stampede or stale read (perf/bugs). Ground truth + system tests +
  opt-in packed journey, same conventions as conduit-api.
- Also make `sw inspect` understand plain `node:http` routing (routes for conduit-api become
  visible) — owns src/engines/architecture/** for that.
- Every SECOND WORLD bug found → main with reproduction.

## Deferred (with reason)
- Shrinking the 18 frozen cross-engine imports: most are legitimate reuse (stress→performance,
  reporting→engine types); the ratchet test prevents new ones. Revisit if engines become packages.
- SEA binaries, docs site, HTTP/3, gRPC: roadmap "later", not needed for a 0.1.0 npm release.
