# 11 — Safety, Security & Privacy

SECOND WORLD generates traffic, injects faults, and runs commands. Safety is a **core module** (`core/safety`) that every outbound action must pass through. It is not left to individual engines.

## 1. Threat model

Written in wave 8 (security review). Each mitigation names the code that enforces it and a test that
proves it. "Residual" says what is **not** covered. Fuzz tests use fast-check with fixed seeds.
Set `SW_FUZZ_RUNS` / `SW_FUZZ_SEED` for a longer or different run, e.g.
`SW_FUZZ_RUNS=5000 SW_FUZZ_SEED=7 npx vitest run tests/unit/security`.

### 1.1 Assets

| Asset | Why it matters |
|---|---|
| **Target systems** (the user's APIs, and anything reachable from the machine: LAN hosts, cloud metadata, third-party sites) | SECOND WORLD generates load and mutating requests. Pointed at the wrong host it is a DoS or an SSRF tool |
| **Credentials** (test-account tokens, cookies, API keys from `auth`, `{ env }` / `{ file }` secrets, tokens returned by the target) | Leaking them in a report or artifact that gets shared (CI artifact, bug ticket) |
| **The user's machine** (files, processes, shell) | Code execution from data the tool reads |
| **Reports, history, artifacts, audit log** | Integrity (decisions are made on them) and confidentiality (they hold request/response samples) |

### 1.2 Actors

| Actor | Trust | Can control |
|---|---|---|
| The user (CLI flags, the `sw.config.*` they wrote) | Trusted. A TS/JS config is code they chose to run | Everything, within the Safety Guard's hard rules |
| **Hostile target** (the API under test: its responses, headers, redirects, DNS answers) | Untrusted | Response bodies and headers, `Location`, `Set-Cookie`, timing, DNS for its name |
| **Hostile inputs** (OpenAPI file, traces/metrics, reproduction artifacts from someone else, the repo `sw inspect` reads) | Untrusted data | Operation names, paths, examples, module paths named in artifacts, source code text |
| **Malicious config in a cloned repo** | Untrusted until the user runs it | A `sw.config.ts` is code: it runs on load unless `--no-config-code`. JSON/YAML configs are data but can widen `allowHosts` |
| **Other local processes / users** | Partly trusted | Files in `.second-world/` (history, audit log), DNS/hosts file, ports |

### 1.3 Trust boundaries

1. **Process → network.** Every request passes `checkTarget`, DNS pinning (`lookup`) and `checkRedirect`
   (`src/core/safety/guard.ts`, `src/adapters/http/undici-executor.ts`).
2. **Network → process.** Responses are data: parsed, size-capped, never executed.
3. **Process → disk.** Reports, artifacts, HAR, history, logs and the audit log pass the redactor
   (`src/core/log/redact.ts`, `src/core/log/logger.ts`).
4. **Disk/input → process.** OpenAPI, artifacts, history and HAR are parsed with schemas. Only the user's
   config code and invariant modules **inside the project** are imported.
5. **Process → child processes.** argv arrays only, no shell (`execa` / `spawn`).

### 1.4 STRIDE

| # | Threat (STRIDE) | Example | Mitigation (code) | Proof (test) |
|---|---|---|---|---|
| T1 | **Spoofing / Elevation**: reach a host that is not allowed by spelling it differently | `http://2130706433/`, `0x7f.1`, `１２７.０.０.１`, `[::ffff:a00:1]`, `127.0.0.1@evil.com`, `evil.com\@127.0.0.1`, zone ids | WHATWG URL parsing, then classification of the canonical host (`classifyHost`, `checkTarget` in guard.ts) | tests/unit/security/guard-fuzz.test.ts: "default config…", "every IPv4 spelling…", "private CIDR…", "public hosts need…" (2000 runs each; an independent oracle checks that anything allowed is loopback or listed) |
| T2 | **Spoofing**: DNS rebinding / tampered resolution | `localhost` or an allowed name resolves to a LAN, public or metadata IP, or flips mid-run | DNS pinned once at pre-flight; every resolved address classified. A loopback name (`localhost`, `*.localhost`) must resolve to loopback unless the addresses themselves are listed. `lookup` serves only pinned addresses; `recheckDns` kills the run on a class change (guard.ts `resolveAndCheck`, `lookup`, `recheckDns`) | guard-fuzz.test.ts "DNS pinning and rebinding", "regressions", "compatibility (a)(b)(c)"; tests/unit/core/dns-pinning.test.ts |
| T3 | **Elevation**: redirect to another host | `302 Location: http://169.254.169.254/` | Every hop re-checked by `checkRedirect`; credentials stripped on cross-origin hops (undici-executor.ts) | guard-fuzz.test.ts "redirects…"; tests/unit/http/undici-redirect.coverage.test.ts |
| T4 | **DoS of the tool** | Stalled resolver, huge bodies | DNS bounded by `dnsTimeoutMs` (default 10 s); body caps and timeouts in the executor | tests/unit/security/dns-timeout.test.ts; undici-redirect.coverage.test.ts "readBody keeps at most…" |
| T5 | **Tampering / Elevation**: code injection into exported tests | OpenAPI operation name with U+2028, `` ` ``, `${}`, `*/`, quotes | Every value embedded with `JSON.stringify` plus U+2028/2029 escaping; the role map has a null prototype (src/engines/agent/export.ts) | tests/unit/security/export-injection-fuzz.test.ts: the syntax tree equals that of a defanged twin, 0 parse errors (300 runs), plus an evaluation smoke test |
| T6 | **Elevation**: code execution from an artifact | A `bugs-*.json` from someone else names `C:/…/evil.mjs` as an invariant module | `sw replay` imports invariant modules only from inside the project; otherwise `inconclusive`, exit 2 (src/engines/bugs/artifact.ts `outsideProject`) | tests/unit/security/artifact-path.test.ts, replay-cli-outside.test.ts |
| T7 | **Elevation**: shell injection | Hook `reset: "x; rm -rf ~"`, docker image names | No shell anywhere; strings are split into argv by a parser without metacharacters | tests/unit/security/child-process.test.ts (repo-wide scan: no `shell: true`, no `exec`; reviewed list of spawners; split-property fuzz) |
| T8 | **Tampering**: path traversal | Export file name `../../x.ts`, replay id `../..` | Export writes the `basename` only (src/cli/commands/agent.ts `exportSuggestedTests`); replay ids match a directory listing with `^bugs-[0-9a-f]+\.json$` (src/cli/commands/bugs.ts `findReproduction`); artifact names are hashes | artifact-path.test.ts "suggested-test export stays inside its directory" (300 runs) |
| I1 | **Information disclosure**: secrets in outputs | `{"password":"hunter2"}` body, `?access_token=…`, `Cookie: sid=…`, `secretKey`, `X-Api-Key` | Redactor: known headers, exact config secrets, patterns, sensitive-name assignments in free text (any length, quoted values whole), credential header lines, entropy rule. HAR and curl share one header/param rule (`isSensitiveHeader`, `isSensitiveParam`, `redactUrlParams`) and write `[REDACTED]` | tests/unit/security/redaction-fuzz.test.ts (redactString, redactObject, logger text/JSON, audit log memory+file, HAR; 1500 runs); curl-redaction.test.ts |
| I2 | **Information disclosure**: credentials in reproductions | curl / HAR / exported tests | Role credentials appear as `$SW_AUTH_<ROLE>` placeholders; exported tests read them from the environment | curl-redaction.test.ts; tests/unit/bugs/har.test.ts |
| R1 | **Repudiation**: "I never approved that" | Approval, public target, kill switch | Hash-chained audit log, `sw history verify` (§3) | tests/unit/safety/audit-chain.test.ts, history-verify-audit.test.ts |
| D1 | **DoS of the target** | Wrong unit, runaway loop | Budgets and GCRA, world-wide caps (§2) | tests/unit/safety/world-rate-cap.test.ts, tests/unit/core/safety.test.ts |
| S1 | **Supply chain** | Compromised dependency or publish | Lockfile; `npm audit --omit=dev` clean (2026-11-01: 0 vulnerabilities). Publishing only from the tag workflow with `--provenance`, `id-token: write`, `contents: read`, after the full checks (.github/workflows/release.yml). The tarball holds only `dist/`, `LICENSE`, `README.md` and `package.json` | `npm pack --dry-run`: 131 files, no tests, fixtures or source maps |

### 1.5 Residual risks

- **A TS/JS config is code.** Running `sw` in a cloned repo with a malicious `sw.config.ts` runs that code.
  `--no-config-code` restricts loading to JSON/YAML. A JSON config can still widen `allowHosts`: review
  the `safety` block of configs you did not write.
- **An explicitly listed name vouches for private answers.** `allowHosts: ["api.example.com"]` with
  `allowPublic` also lets that name resolve to 10.x or 169.254.x. This is explicit user intent, and
  `host.docker.internal` and LAN names rely on it (tests/unit/core/dns-pinning.test.ts). If the name's
  DNS could be hostile, list IPs/CIDRs instead of names.
- **Option injection, not shell injection.** Config values that become argv (docker image or container
  names, hook arguments) are not shell-interpreted, but a value starting with `-` reaches the program as
  an option. These values come from the user's config, not from targets.
- **Redaction is heuristic.** The redactor does not recognise a secret under a neutral name
  (`{"data": "s3cr3t"}`) when it has low entropy and no known pattern. Configure it as an `{ env }` /
  `{ file }` secret (exact match) or add `safety.redact` patterns. Double-encoded JSON (a JSON string
  inside a JSON string) is covered only by exact secrets and patterns.
- **History index integrity.** `sw history` trusts the `file` field of `index.jsonl` entries: whoever can
  edit `.second-world/history` can point a read at another gzip file. Same-user local access is assumed
  trusted (reported to main, wave 8).
- **Prometheus scrape** (`sw model` with a metrics URL; src/engines/model/build.ts) checks the URL but
  uses global `fetch`, which follows redirects and does not use DNS pinning. This was found by reading the
  code and has no test yet; reported to main (wave 8). Scrape only endpoints you control.
- **Workflow actions are pinned by tag (`@v4`), not by commit SHA.** Pin them to SHAs once the repository
  exists.
- **Not run here:** the release workflow needs a GitHub repository, an `npm` environment with
  `NPM_TOKEN`, and a public repo for provenance.

### 1.6 Summary table (pre-wave-8, still valid)

| Threat | Example | Control |
|---|---|---|
| Accidental DoS of a third party | Typo in target URL → hammering a real site | Host allow-list, default local-only, pre-flight confirmation for non-local hosts |
| Runaway load | Wrong unit (`rate: 20000`) | Hard budgets (`maxRps`, `maxRequests`, `maxDuration`, `maxConcurrency`), GCRA enforcement. `maxRps` and `maxRequests` are per world: engines running concurrently in one run share them (`src/core/safety/guard.ts`, tests/unit/safety/world-rate-cap.test.ts) |
| Testing production unintentionally | Staging config pointing at prod DB | `environment` label, prod requires explicit flags + typed confirmation. Mutations blocked by default |
| Data leakage in reports/logs | Bearer tokens in HAR files | Redaction pipeline on everything persisted |
| Source code leakage | Proprietary code sent to an external service | Nothing is ever sent to an external service: no AI, no phone-home. Outbound traffic goes only to allow-listed targets and configured telemetry endpoints |
| Malicious repository | Inspecting an untrusted repo runs its code | Static analysis never executes code. `--no-config-code`, `--no-plugins` |
| Generated harmful actions | Agent scenario that deletes data | Generated scenarios are data (Zod-validated DSL), never code. Safety validator; destructive operations need approval. Sandbox for evolution |
| Leftover faults | Toxiproxy latency left on after crash | Cleanup stack, fault TTL, watchdog, `sw reliability cleanup` |
| Redirects to other hosts | 302 to an external domain | Redirects followed only to allowed hosts (else recorded, not followed) |
| SSRF via templates/data files | Data file injects a URL | Hosts are checked at request time, after template expansion |
| Supply chain | Compromised dependency | Minimal deps, lockfile, provenance, `npm audit signatures`, Renovate with review |

## 2. Safety Guard

```ts
interface SafetyGuard {
  checkTarget(url: URL): Decision;                // allow-list, private/public IP class, environment label
  reserve(budget: BudgetRequest): Lease;          // requests, rps, concurrency, bytes, duration
  requireApproval(action: DisruptiveAction): Promise<void>;   // interactive confirm or flag/token
  audit(event: AuditEvent): void;                 // append-only audit log
  killSwitch: AbortSignal;                        // global abort
}
```

### Target classification

| Target | Default |
|---|---|
| Loopback (`127.0.0.0/8`, `::1`, `localhost`) | Allowed |
| Private ranges (RFC 1918, `fc00::/7`, `*.internal`, `*.local`), `host.docker.internal` | Allowed if in `allowHosts` |
| Public IPs/hosts | Blocked unless in `allowHosts` **and** confirmed (interactive) or `--yes` with `safety.allowPublic: true` |

DNS is resolved once at pre-flight and **pinned**. A DNS change mid-run (rebinding) to an unlisted IP class aborts the run.
Each resolution is bounded by `dnsTimeoutMs` (default 10 s; `getaddrinfo` has no timeout of its own). A loopback
name (`localhost`, `*.localhost`) must resolve to loopback addresses. A LAN or public answer for it is refused
unless those addresses are themselves in `allowHosts` (T2).

### Disruptive actions (require approval)

Fault injection, state-changing requests in Bug Hunter/Agent, Evolution builds/execution, breakpoint stress tests above `safety.maxRps/2`, and anything with `environment: production`.

## 3. Audit trail

Append-only JSONL at `<project>/.second-world/audit.log`, written when a config file is used (the
config file's folder is the project; `src/core/world.ts`). One line per safety decision: who (OS user,
CI job), when, what (action such as `target.allowed`, `safety.blocked`, `budget.reserved`,
`approval.granted` with its source, `kill-switch`; target and detail), all passed through secret
redaction (`src/core/safety/guard.ts` `audit`). The log is not copied into report artifacts.

Hash chain: every entry stores `prevHash` (the hash of the entry before it in the file; 64 zeros for
the first) and `hash` = SHA-256 over `prevHash` and its own content. Parallel `sw` processes in one
project extend the same chain: each append re-reads the chain head from the file under a short
`audit.log.lock` lock (tests/unit/safety/audit-chain.test.ts, 4 processes × 50 entries).

`sw history verify` checks the chain after the history store (`src/cli/commands/history.ts`):

```text
$ sw history verify
✔ history intact: 6 run(s) checked, 0 error(s), 0 warning(s)
✖ audit log TAMPERED or corrupted: hash chain broken at line 2 (the entry was modified) — …/.second-world/audit.log
```

- Exit 1 when the chain is broken (an entry edited → "the entry was modified"; an entry removed,
  reordered or replaced → "an earlier entry was removed, reordered or replaced"), the same code as a
  corrupted history store. Exit 0 when intact or when there is no audit log yet (reported as "none").
- `--json` adds `audit: { file, present, ok, entries, brokenAt?, reason?, torn? }` and `history.ok`; the
  top-level `ok` covers both.
- A line cut short by a crash mid-write is reported as a warning (`torn`), not tampering: the next
  entry chains to the last complete one.
- Limits: a hash chain cannot detect entries removed from the **end** of the file. Replacing the
  last entry with unparseable bytes therefore only gives the torn-line **warning** (exit 0), not a
  failure: it cannot be told apart from a crash mid-write. Nor can it detect a whole file
  rewritten with a fresh valid chain by someone with write access. Keep the log somewhere append-only
  (or ship it off the machine) if that matters. The same check is available as `verifyAuditLog(file)`.

## 4. Secret redaction & data minimisation

Pipeline applied to logs, reports, artifacts and dry-run output:

1. **Known locations**: configured headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `proxy-authorization`) and JSON paths.
2. **Config secrets**: every resolved `{ env }`/`{ file }` secret value is added to an exact-match deny-set.
3. **Patterns**: JWT, AWS/GCP/Azure keys, common SaaS API key prefixes, private-key PEM blocks, connection strings with passwords, basic-auth URLs.
4. **Entropy**: strings ≥ 20 chars with Shannon entropy > 4.0 near key-like names. A clearly sensitive name (`access_token`, `client_secret`, `password`, `api_key`, …, also in camelCase) is redacted whatever the entropy, because hex tokens stay below 4.0.
5. **PII (opt-in)**: emails, phone numbers, IPs, card numbers (Luhn-checked).

Free text (bodies, URLs, curl lines) also gets two more rules. First, any value assigned to a sensitive name
(`"password":"x"`, `?access_token=x`, `client_secret: 'a b c'`) is redacted whatever its length, and a quoted
value is redacted whole. Second, credential header lines (`Cookie: …`, `Authorization: …`, `x-api-key: …`) are
redacted to the end of the line. Keys match in snake, kebab, camel, Pascal, UPPER and acronym forms (`XApiKey`,
`SECRET_KEY`). HAR and curl reproductions use one shared header/param rule and write `[REDACTED]` (I1).

Replacement: `«redacted:abcd1234»` (first 8 hex digits of the SHA-256), so equal values stay correlatable without being revealed. Response bodies are stored only as samples (bounded size) and only when needed.

## 5. Execution safety

- Commands from config (`hooks`, `evolve --test`) are run with `execa` as an **argv array, no shell**. A string form is split with a documented parser. There is no shell option. If you really need a shell, use an explicit interpreter (`["sh", "-c", "…"]`). The scan in tests/unit/security/child-process.test.ts keeps it that way (T7).
- Timeouts on every external command. The process tree is killed on timeout/cancel.
- Evolution candidates run in Docker with `--network` restricted, CPU/mem limits, read-only mounts except the worktree, and a non-root user.

## 6. Deterministic by design

- SECOND WORLD uses no AI or LLM anywhere. Every result comes from measurement, analysis or code, so the same input and seed give the same result, and every claim can be traced to its evidence.
- Code, reports and evidence never leave the machine.
- Response bodies, code comments and logs are **untrusted data**: they are parsed and recorded, never executed. Generated scenarios (Agent) are schema-validated data that must pass the Safety Guard before anything is sent.

## 7. Security of the package itself

- `SECURITY.md` with a disclosure process. CodeQL + dependency scanning in CI.
- Publish with npm **provenance** (`--provenance`) from GitHub Actions OIDC: `.github/workflows/release.yml`.
  The workflow is tag-triggered (`v<version>` must equal the package.json version). It first runs the full CI
  checks plus `npm audit --omit=dev`. Only the publish job gets `id-token: write`; everything else has
  `contents: read`. Not run yet (needs the GitHub repo and an npm token). 2FA on maintainers.
- No telemetry/phone-home. If ever added: opt-in, documented, anonymous.

## 8. Responsible-use statement

SECOND WORLD is for testing systems you own or are explicitly authorised to test. Defaults enforce this (local-only targets, test accounts only, no exploit payloads). The docs and `sw init` show this statement.
