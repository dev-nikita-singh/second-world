# Wave 7 — Product hardening (plan + rules)

Goal (user, 2026-11-01): make SECOND WORLD a strong, install-ready product people run on their own
machine or CI. Fix every real issue we can find (including race conditions *inside the tool*),
apply sound system-design practice, and prove it against a realistic project. Branch `wave-7`
(from master = wave-6 merged). Max 4 agents at a time.

## Rules for every wave-7 agent (in addition to .agents/README.md)

1. **No claim without evidence.** Every "fixed", "works", "faster", "safe" in your progress file or
   final report must point to a test, a command you ran, or a file:line. If you did not run it, say
   "not verified". Never invent APIs, flags, file paths or results: open the file first.
2. **Reproduce first.** For each bug: write a test that fails on the current code, then fix, then
   show it passes. Keep the test. Flaky = failing; do not mark done.
3. **Smallest correct change.** Fix root causes, don't add options nobody asked for. Match the
   surrounding code style. No new dependencies without asking main (and justify it).
4. **Stay in your lane.** Edit only the paths you own (BOARD.md wave 7 table). Found a bug outside
   your lane → message `main` with file:line, a reproduction and the suggested fix.
5. **Determinism and safety stay intact.** No AI/LLM anything. Local targets only. No secrets in
   outputs. Don't weaken the Safety Guard to make a test pass.
6. **Cross-platform.** Windows, macOS, Linux. node:path, port 0 on 127.0.0.1, no `shell: true`.
   Write files LF (repo has `.gitattributes eol=lf`).
7. **Lint clean.** Your files must pass `npx biome check <your files>` and `npx tsc --noEmit`.
8. **Tests to run before reporting:** your own areas plus `npx vitest run tests/unit` (fast).
   main runs the full suite (≈20 min) before each commit.
9. **Never commit / stash / reset / checkout.** main reviews and commits per agent.
10. **Checkpoint** `.agents/progress/<you>.md` after each finished unit; resume from it.

## Workstreams

### A. sw-race7 — concurrency correctness of the tool itself
Audit and fix races, leaks and crash-consistency in SECOND WORLD (not in the target):
- two `sw` processes at once on the same project: history JSONL appends + index, baselines,
  report dir, `.second-world/` caches, artifacts dir naming — no lost, torn or interleaved writes;
- atomic writes (temp file + rename, fsync where it matters), partial-file recovery on read;
- process lifecycle: SIGINT/SIGTERM during writes, child processes and git worktrees always
  cleaned, no unhandled rejections, timers/sockets closed (no hanging process);
- in-process async races: shared mutable state across concurrent requests/VUs, Promise.all
  without cancellation, event ordering.
Deliver: tests that run real concurrent `sw` processes; a short "Concurrency model" section in
docs/02-architecture.md. Optional after the above: `node:sqlite` history backend (WAL) or remove
the unimplemented option from docs — decide with evidence and tell main.

### B. sw-design7 — system design review and enforcement
- Write `docs/16-system-design.md`: the real design as built (layers, data flow, error taxonomy &
  exit codes, timeouts/retries/backoff, backpressure & bounded memory, idempotency, graceful
  shutdown, observability, config precedence, versioned schemas, security boundaries) — each
  section cites files. Where the code violates a principle, fix it (in your lane) or file it.
- Enforce architecture with tests: an import-rule test (core ↛ engines ↛ cli; no cycles), public
  API snapshot test for `src/index.ts` exports, schema v1 freeze tests for report/history/evidence
  JSON (+ migration tests for older history records), CLI startup time and memory budget test.
- Outbound HTTP resilience review (timeouts on every call, bounded retries with jitter, no
  unbounded queues) in src/adapters/** and src/core/**.

### C. sw-real7 — realistic project + real user journey
- Build `examples/conduit-api`: a RealWorld "Conduit"-style API (users, login tokens, profiles,
  follow, articles, comments, favorites, tags, pagination) on `node:sqlite` with real
  transactions, an OpenAPI file, `sw.config.ts`, README, and `expected-findings.json` listing
  planted defects (incl. a favorites-count race, a missing auth check, an off-by-one pagination,
  a 500 on unusual input, a slow N+1 endpoint). Same conventions as shop-express.
- Run every `sw` command against it from a packed tarball installed into a fresh temp project
  outside the repo (the real user journey: `npm pack` → `npm i <tgz>` → `npx sw init/doctor/
  perf/stress/bugs/agent/reliability/inspect/model/analyze`). Record recall/precision.
- Every SECOND WORLD bug found → reproduction to main (or fix if it's in your lane).
- System tests under tests/system/ that run this journey (skippable when slow, documented).

### D. sw-ship7 — release engineering
- `.github/workflows/ci.yml`: matrix ubuntu/macos/windows × Node 22.19/24, lint, typecheck,
  unit, integration, e2e, pack-and-install smoke; a Linux job that runs the Docker-backed tests
  with docker and with podman (closes the "Docker only tested on Windows" gap in CI).
- `action.yml` GitHub Action for users (run sw, upload SARIF), `Dockerfile` (multi-stage,
  non-root, slim) + `.dockerignore`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`,
  README install section for npm / npx / Docker / CI.
- Lint to zero errors and zero warnings repo-wide — do this LAST, only after main says the other
  agents are done (they edit the same files).
- `sw doctor`/`sw init` first-run UX check in a clean temp dir; fix what's confusing.

## Order
main: format + merge (done) → spawn A, B, C, D in parallel → review/commit each → full suite →
fix what C reports → D's final lint pass → full suite ×2 (flake check) → merge to master.
