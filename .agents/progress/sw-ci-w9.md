# sw-ci-w9 progress — DONE (reported to main)

## Task
Flaky shop-express from-config reliability cases on slow CI runners (no-circuit-breaker missed in 5xx; extra slow-recovery in timeout).

## Root causes (reproduced in WSL, taskset -c 0,1 + busy loop)
1. no-circuit-breaker: late-half client error rate counted requests still in flight at the revert; they
   succeed against the restored dependency. Fault = 5.00x s -> 6 windows -> late half = last 2 full
   seconds, one of which is all censored successes -> lateErrorRate ~0.48-0.54 vs the 0.5 bar (coin flip).
2. slow-recovery: recovery phase 3 s = exactly 3 windows = `consecutive`, so any transient in the first
   second after the revert (backlog drain of ~70 released orders, p95 60-120 ms vs bound ~65 ms) => "No
   recovery within 3 s" though the last windows were clean (~11 ms).

## Done
- detectors.ts: detectCircuitBreaker opts.decided (outcome only from requests answered before revert);
  recoveryTime.degradedAtEnd (last 2 windows with traffic out of bounds).
- runner.ts: decided windows passed to breaker; slow-recovery requires degradedAtEnd; limitation
  recovery-unconfirmed otherwise; methods text. findings.ts summary text.
- unit tests (detectors.test.ts) 111/111 Windows.

## Verified
- 2 cases, taskset -c 0,1 + busy loop on core 1: Linux Node 24 10/10, Node 22.19 10/10 (before fix: 1/4).
  Breaker lateErrorRate now 1.00 in every run (was 0.48-0.54); recovery-unconfirmed in most runs, never degradedAtEnd.
- Windows 3/3. unit/reliability + integration/reliability + integration/examples: 223 pass/1 skip on
  Windows, Linux Node 24, Linux Node 22 (2 CPUs). tsc clean, biome clean on owned files.
## Not done (outside ownership)
- docs/03-engines/reliability-lab.md §3 rows (recovery, breaker) + CHANGELOG: proposed to main.
