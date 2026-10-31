# Contributing to SECOND WORLD

Thanks for helping. SECOND WORLD measures other people's systems, so it has to be more correct than they are:
every change comes with a test, and every claim in a PR (fixed, faster, safe) points at a test or a command.

## Setup

Requirements: Node.js ≥ 22.19 (24 recommended), npm, git. Docker is optional (only the live Docker tests use it).
Windows, macOS and Linux are all supported development platforms.

```bash
git clone <this repo> second-world && cd second-world
npm ci
npx tsx src/cli/main.ts --version     # run the CLI from source (also: npm run sw -- --version)
```

## Scripts

| Command | What it does |
|---|---|
| `npm run lint` | Biome lint + format check on `src`, `tests`, `examples` (CI adds `--error-on-warnings`) |
| `npm run format` | Apply Biome formatting |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run test:unit` | Unit and property tests (`tests/unit`, run in parallel) |
| `npm run test:integration` | Engines against real local servers (`tests/integration`, one file at a time) |
| `npm run test:e2e` | The CLI as a user runs it (`tests/e2e`) |
| `npm test` | Everything, including `tests/system` and `examples/**` tests (≈ 20 min) |
| `npm run build` | Bundle `dist/` with tsdown (`npm pack` runs it first) |

Run one area while you work: `npx vitest run tests/unit/<area>`. Before opening a PR run at least
`npm run lint`, `npm run typecheck` and `npm run test:unit`; CI runs the rest on Ubuntu, macOS and Windows with
Node 22.19 and 24.

Docker-backed tests (`tests/integration/docker/**`, part of `tests/e2e/evolve-cli.test.ts`) skip by themselves
when `docker info` fails. To run them: start Docker, then `npx vitest run tests/integration/docker`.

To try the package the way users get it:

```bash
npm pack                                   # builds dist/ and writes second-world-<version>.tgz
cd /some/empty/dir && npm init -y && npm i -D /path/to/second-world-<version>.tgz
npx sw doctor
```

## Conventions

These come from [docs/12-testing-and-quality.md](docs/12-testing-and-quality.md) §6 and the existing code:

- **Deterministic, no AI.** No LLM or other AI anywhere. The same inputs and seed give the same results.
- **TypeScript strict** (plus `noUncheckedIndexedAccess`), ESM with `.js` import suffixes
  (`import { x } from "./y.js"`).
- **Engines** use the context's clock and RNG (`ctx.clock`, `ctx.rng`): no `Math.random`, no `Date.now()` for
  durations. No `console.*` outside `src/cli`. No recursion on user-sized input; memory stays bounded.
- **Safety first.** Every outbound request goes through the Safety Guard; never weaken it to make a test pass.
  Secrets never reach output unredacted.
- **Portability.** Use `node:path`; bind test servers to port `0` on `127.0.0.1`; never hard-code ports; never use
  `shell: true` (commands are argv arrays). Files use LF line endings (`.gitattributes`).
- **Spec first.** Behaviour is described in `docs/`; cite the section in the file's header comment and update the
  doc in the same change when behaviour changes.

## Tests

- Unit tests go in `tests/unit/<area>/`, integration tests in `tests/integration/<area>/`.
- **Every bug fix starts with a test that fails on the old code**, then the fix, then the passing test. Keep it.
- A flaky test is a failing test. Fix the cause (CPU contention, timers, ports) instead of retrying.
- Findings from the example apps are checked against their `expected-findings.json`; keep recall and precision.

## Commits and pull requests

- One logical change per commit. Subject line `<area>: <what changed>` in the imperative, as in the history
  (`cli: no ANSI colour in piped errors; …`, `redact: camelCase sensitive keys …`). Mechanical changes
  (formatting, renames) go in their own commit and say "no behaviour change".
- Add a line to `CHANGELOG.md` under **Unreleased** for anything a user can notice.
- PRs must pass CI. Describe what you ran and what you could not verify.

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).
