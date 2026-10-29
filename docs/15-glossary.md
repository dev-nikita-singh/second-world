# 15 — Glossary

| Term | Definition |
|---|---|
| **A/A test** | Comparing a configuration against itself to measure environmental noise and the minimum detectable effect |
| **Arrival rate** | Requests started per second in an open workload model, independent of response times |
| **Baseline** | A stored reference run that new runs are compared against |
| **Blast radius** | The set of systems/users a disruptive experiment can affect |
| **Bootstrap CI** | Confidence interval obtained by resampling the observed data with replacement |
| **Capability** | An environment feature an engine may need (Docker, git, network target, telemetry) |
| **Classification ladder** | hypothesis → suspected-risk → observation → threshold-breach → reproduced-defect → verified-fix |
| **Closed model** | Workload where a fixed number of virtual users each wait for a response before the next request |
| **Condensation graph** | A graph where each strongly connected component is collapsed into a single node (always a DAG) |
| **Coordinated omission (CO)** | Measurement error where a load generator slows down along with a stalled server and so under-samples bad latencies |
| **CSR** | Compressed Sparse Row: a compact array-based graph representation |
| **CUSUM** | Cumulative-sum control chart for detecting sustained shifts in a series |
| **Delta debugging (ddmin)** | An algorithm that minimises a failing input/sequence to a 1-minimal failing subset |
| **Engine** | An independent SECOND WORLD module (Performance Lab, Architecture Inspector, …) |
| **Environment fingerprint** | Recorded OS, CPU, runtime, versions and target resolution, used to judge comparability |
| **Evidence** | Typed data supporting a finding: measurement, code location, HTTP exchange, trace, comparison, note |
| **Fingerprint (finding)** | A stable hash identifying the "same" finding across runs |
| **GCRA** | Generic Cell Rate Algorithm: an exact, O(1) token-bucket rate limiter |
| **HDR histogram** | High Dynamic Range histogram: fixed-memory, bounded-relative-error latency recorder |
| **Knee** | The load level where the latency curve bends sharply upward |
| **Limitation** | An explicit statement in a report of what could not be determined, and why |
| **Linearizability** | A correctness condition: concurrent operations appear to take effect atomically in real-time order |
| **Little's Law** | L = λW: mean concurrency = throughput × mean latency |
| **Open model** | Workload where requests arrive on a schedule regardless of responses |
| **Pareto front** | The set of candidates not dominated on all metrics by any other candidate |
| **Profile** | A named config overlay (e.g. `ci`, `smoke`) |
| **Property-based testing** | Generating many inputs and checking that stated properties always hold, with shrinking of failures |
| **Reproduced defect** | A failure of an explicit expectation that re-occurs on replay |
| **SARIF** | Static Analysis Results Interchange Format, understood by GitHub code scanning and IDEs |
| **SCC** | Strongly connected component: a maximal set of nodes that are all mutually reachable (a dependency cycle) |
| **Steady state** | Measurable normal behaviour used as the baseline hypothesis in reliability experiments |
| **Summary** | The output of `sw analyze`: a deterministic digest of one or more reports (counts, strongest evidence, top findings, invalidating limitations) |
| **USL** | Universal Scalability Law: a model of throughput vs concurrency with contention and coherency terms |
| **Virtual user (VU)** | A simulated client looping through a scenario in the closed model |
| **Warm-up** | Initial period excluded from metrics so that JIT, caches and pools stabilise |
| **Worktree** | A git feature for checking out another commit into a separate directory without touching the main working tree |
