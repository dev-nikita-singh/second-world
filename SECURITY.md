# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue or pull request:

- Use GitHub's private vulnerability reporting on this repository (**Security → Report a vulnerability**).
- Include the SECOND WORLD version (`sw --version`), your OS and Node version (`sw doctor --json` is useful;
  it redacts proxy credentials), the command and config you ran (remove secrets), and what happened.

We acknowledge reports as soon as we can and agree a disclosure date with you. Fixes land with a
regression test and a `CHANGELOG.md` entry; credit is given unless you ask otherwise.

Releases are published to npm only from the tag-triggered GitHub workflow (`.github/workflows/release.yml`) with
npm provenance, so `npm audit signatures` can verify a tarball came from this repository's CI.

Supported versions: SECOND WORLD has no release yet. Until `1.0`, only the latest release (and `main`) receive
security fixes.

## What counts as a vulnerability

SECOND WORLD sends load and test requests, injects faults and runs configured commands, so these are in scope:

- a way to make it send traffic to a host that the Safety Guard should have blocked (allow-list, public-host
  confirmation, DNS pinning/rebinding, redirects to other hosts);
- budgets (`safety.maxRps`, `maxConcurrency`, `maxRequests`, `maxDuration`) that can be exceeded;
- a secret that reaches a log, report, artifact, history record or dry-run output unredacted;
- code execution from data: an inspected repository, an OpenAPI file, a response body or a generated test case
  that gets executed (instead of parsed), or a shell command built from untrusted input;
- a fault that is not reverted (Reliability Lab) or a sandbox escape in the Evolution docker sandbox;
- tampering with the audit log that goes undetected.

Out of scope: load you deliberately configured against a system you own; findings in the example apps under
`examples/` (their defects are planted on purpose).

## How SECOND WORLD stays safe by default

The full design is in [docs/11-safety-security-privacy.md](docs/11-safety-security-privacy.md). In short:

- **Local targets only by default.** Loopback is allowed; private hosts (including `host.docker.internal`) must be
  listed in `safety.allowHosts`; public hosts also need `safety.allowPublic: true` and confirmation. DNS is
  resolved once and pinned, and a mid-run change to another address class aborts the run (exit 3).
  Redirects are only followed to allowed hosts, and custom credential headers are dropped on cross-origin redirects.
- **Budgets** (`maxRps`, `maxConcurrency`, `maxRequests`, `maxDuration`) are enforced by the Safety Guard (docs/11 §2);
  a requested rate above `maxRps` is refused (exit 3) and closed/VU load is throttled to it.
- **Opt-in for anything disruptive.** Mutating requests, fault injection and sandboxed builds need an explicit flag
  or confirmation (`--allow-mutations`, `--approve-disruptive`, `--yes`), and faults are always reverted
  (cleanup stack, TTL, watchdog, `sw reliability cleanup`).
- **Redaction** of headers, configured secrets (`{ env }` / `{ file }`), token patterns and high-entropy values next
  to sensitive names in logs, reports, artifacts and dry-run output (docs/11 §4). Reproductions use
  `$SW_AUTH_<ROLE>` placeholders instead of credentials.
- **Audit log.** Approvals and disruptive actions are appended to `.second-world/audit.log`. Each entry carries the
  hash of the previous one (`src/core/safety/guard.ts`), so edits are detectable; `verifyAuditLog()` from the
  package API checks the chain.
- **No code execution from data.** `sw inspect` parses code and never runs it; `--no-config-code` loads only
  JSON/YAML configs; commands from config run as argv arrays with no shell. `sw replay` loads invariant modules
  named in a reproduction artifact only from inside the current project, so replaying an artifact someone sent
  you cannot run code from elsewhere on disk. Exported agent tests embed every value as a JSON literal.
- **Fuzzed.** The Safety Guard's URL/IP/DNS handling, redaction (logs, audit log, HAR, curl), exported test code
  and command splitting are property-tested with fast-check (`tests/unit/security/`; threat model and residual
  risks in docs/11 §1).
- **Nothing leaves the machine.** No AI, no telemetry, no phone-home: traffic goes only to your allow-listed
  targets and the telemetry endpoints you configure.

Use SECOND WORLD only against systems you own or are explicitly authorised to test.
