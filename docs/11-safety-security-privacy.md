# 11 — Safety, Security & Privacy

SECOND WORLD generates traffic, injects faults, and runs commands. Safety is a **core module** (`core/safety`) that every outbound action must pass through. It is not left to individual engines.

## 1. Threat model (what we protect against)

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

Replacement: `«redacted:sha256:abcd1234»` (short hash), so equal values stay correlatable without being revealed. Response bodies are stored only as samples (bounded size) and only when needed.

## 5. Execution safety

- Commands from config (`hooks`, `evolve --test`) are run with `execa` as an **argv array, no shell**. A string form is split with a documented parser. Shell features need an explicit `shell: true`, with a warning.
- Timeouts on every external command. The process tree is killed on timeout/cancel.
- Evolution candidates run in Docker with `--network` restricted, CPU/mem limits, read-only mounts except the worktree, and a non-root user.

## 6. Deterministic by design

- SECOND WORLD uses no AI or LLM anywhere. Every result comes from measurement, analysis or code, so the same input and seed give the same result, and every claim can be traced to its evidence.
- Code, reports and evidence never leave the machine.
- Response bodies, code comments and logs are **untrusted data**: they are parsed and recorded, never executed. Generated scenarios (Agent) are schema-validated data that must pass the Safety Guard before anything is sent.

## 7. Security of the package itself

- `SECURITY.md` with a disclosure process. CodeQL + dependency scanning in CI.
- Publish with npm **provenance** (`--provenance`) from GitHub Actions OIDC. 2FA on maintainers.
- No telemetry/phone-home. If ever added: opt-in, documented, anonymous.

## 8. Responsible-use statement

SECOND WORLD is for testing systems you own or are explicitly authorised to test. Defaults enforce this (local-only targets, test accounts only, no exploit payloads). The docs and `sw init` show this statement.
