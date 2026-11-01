# Troubleshooting

Every error SECOND WORLD prints has the same shape:

```text
✖ <what went wrong> [SW_<CODE>, exit <n>]
  hint: <what to do next>
```

Start with the **exit code** (what kind of problem it is), then look up the **code** below.
`sw doctor` checks your environment (Node, git, Docker, TypeScript, config) in one go.

## Exit codes

| Exit | Meaning | Whose side | First thing to try |
|---|---|---|---|
| 0 | Passed | — | — |
| 1 | Failures found (thresholds breached, defects reproduced) | your app | Read the report; every finding has a reproduction |
| 2 | Usage or config error | your command/config | Read the message: it names the exact key, e.g. `performance.duraton` |
| 3 | Blocked by the Safety Guard | safety settings | Check `safety.allowHosts` / environment; see below |
| 4 | Missing capability (a tool SECOND WORLD needs) | your machine | `sw doctor` |
| 5 | Target problem / nothing measured | your app or network | Is the app running on the target URL? |
| 70 | Bug in SECOND WORLD | us | Report it with `sw doctor --json` output |
| 130 | Cancelled (Ctrl+C) | — | Partial results are still written |

## Config and usage (exit 2)

| Code | Typical cause | Fix |
|---|---|---|
| `SW_CONFIG_NOT_FOUND` | `--config` points to a missing file | Check the path, or omit `--config` to auto-discover `sw.config.*` |
| `SW_CONFIG_INVALID` | Unknown key or wrong type in the config | The message lists each key with its source file and a "did you mean" suggestion |
| `SW_CONFIG_PERFORMANCE`, `SW_CONFIG_STRESS`, `SW_CONFIG_BUGS`, `SW_CONFIG_AGENT`, `SW_CONFIG_RELIABILITY`, `SW_CONFIG_MODEL` | An engine section is invalid | Same: the message names `section.key`. `--dry-run` runs the same checks without sending traffic |
| `SW_CONFIG_NO_TARGET` | No target URL | Pass `--target http://127.0.0.1:3000` or set `targets` in the config |
| `SW_CONFIG_FLAG` | A flag value has the wrong form (e.g. `--mix`) | The message shows the expected form |
| `SW_CONFIG_OUTDIR` | The report folder can't be written | Pass a writable `-o/--out` folder |
| `SW_CONFIG_CODE_DISABLED` | `--no-config-code` refuses a `.ts/.js` config | Use a JSON/YAML config, or drop the flag if you trust the repo |
| `SW_CONFIG_EVOLUTION_GIT`, `SW_CONFIG_EVOLUTION_REF` | `sw evolve`: unknown commit, broken repo, "dubious ownership" | The message includes git's own error; follow its hint (`safe.directory`, check the ref) |
| `SW_HISTORY_NOT_FOUND` | No run with that id/label | `sw history list` |

## Safety Guard (exit 3)

SECOND WORLD only sends traffic where you allowed it. These are working as intended.

| Code | Typical cause | Fix |
|---|---|---|
| `SW_SAFETY_HOST_NOT_ALLOWED` | A private host (e.g. a Docker host name) is not allow-listed | Add it to `safety.allowHosts` |
| `SW_SAFETY_PUBLIC_TARGET` | A public host | Only test systems you own: add it to `safety.allowHosts`, set `safety.allowPublic: true` and confirm (or `--yes`) |
| `SW_SAFETY_PRODUCTION` | `environment: production` | Confirm interactively or `--yes` after reviewing the safety section |
| `SW_SAFETY_APPROVAL_REQUIRED` | A disruptive/destructive action without approval | Add `--yes` / `--approve-disruptive` (recorded in the audit log) |
| `SW_SAFETY_BUDGET` | Requested load is above `safety.maxRps`/`maxDuration`/`maxRequests` | Lower the load or raise the limits in `safety` |
| `SW_SAFETY_DNS_REBIND` | The target's DNS answer changed class mid-run | Possible DNS rebinding; the run was stopped on purpose. Use an IP address or fix DNS |

Running in Docker and testing an app on your machine: use `host.docker.internal` as the host and add
it to `safety.allowHosts` (README, "Docker").

## Missing capability (exit 4)

| Code | Fix |
|---|---|
| `SW_CAP_TYPESCRIPT` | `sw inspect` / `sw model` need TypeScript next to SECOND WORLD: `npm i -D typescript@6` |
| `SW_CAP_GIT`, `SW_CAP_GIT_TIMEOUT`, `SW_CAP_EVOLUTION_GIT`, `SW_CAP_EVOLUTION_WORKTREE` | `sw evolve` needs git and a writable temp folder. On Windows long paths: `git config core.longpaths true` or a short `tmpDir`; stale worktrees: `git worktree prune` |
| `SW_CAP_DOCKER` | Start Docker (`sw doctor` warns "daemon not reachable"), or use the process sandbox |

## Target problems (exit 5)

| Code / limitation | Typical cause | Fix |
|---|---|---|
| `target-unreachable` | Nothing listens on the target URL | Start the app; check host and port |
| `no-measurements` | The app never answered within the timeout | Check the app's health; raise `timeout` or the stage `hold` |
| `SW_TARGET_DNS` | The host name doesn't resolve | Check the name, DNS/VPN, or use an IP |
| `SW_TARGET_APP_UNHEALTHY` | `sw whatif`/`evolve` started the app but it never became healthy | Check the start command, the health path, and that the app listens on `$PORT` |
| `ARCH_NO_FILES` | `sw inspect` found no TS/JS sources | Point it at the project folder: `sw inspect <path>` |

## Common questions

**`sw perf` fails 100% on the first run.** The target has no route at `/`. Add a scenario
(`performance.scenarios`), or run `sw init` next to your OpenAPI file: it picks a public GET for you.

**Error output has strange characters (`ESC[31m`).** Fixed in 0.1.0: colour is only used when the
output is a terminal. Set `NO_COLOR=1` to force plain text.

**`node:sqlite` ExperimentalWarning.** Comes from the example apps, not from SECOND WORLD.

**History says it skipped a line.** A run was killed while saving. `sw history verify` checks the
store and the audit log; a torn last line is reported as a warning.

**A report folder shared by two parallel runs.** Use a different `-o` per run (see docs/02 §4.6).

Still stuck? Run `sw doctor --json` and open an issue with its output and the full error.
