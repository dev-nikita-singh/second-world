# SECOND WORLD — Documentation

> An intelligent software experimentation, testing and optimization engine.
> Status: **specification v2 (pre-development)**. Supersedes `SecondWorld_plan.txt` (v1), which is kept unchanged for reference.

SECOND WORLD helps developers **inspect, load, break, diagnose and improve** software *before* changes reach production. Every capability is an independent engine. You can run any one of them alone, or chain them into a full investigation that shares one configuration, one safety layer and one evidence model.

---

## How to read these docs

| If you want to… | Read |
|---|---|
| Understand what the product is and its rules | [01 – Vision & principles](01-vision-and-principles.md) |
| Understand how the code is organised | [02 – Architecture](02-architecture.md) |
| Learn what each engine does, in depth | [03 – Engines](03-engines/README.md) |
| See every data structure and algorithm, with complexity | [04 – Data structures & algorithms](04-data-structures-and-algorithms.md) |
| Keep the tool itself fast and lean | [05 – Optimization](05-optimization.md) |
| Make it work on Windows, macOS, Linux, Docker, CI… | [06 – Environments & portability](06-environments-and-portability.md) |
| Know every library, why it was chosen, and the alternatives | [07 – Libraries & dependencies](07-libraries.md) |
| Write a config file | [08 – Configuration](08-configuration.md) |
| Use the CLI or programmatic API | [09 – CLI & API](09-cli-and-api.md) |
| Extend it (plugins, rules, fault injectors, reporters) | [10 – Plugins & extensibility](10-plugins-and-extensibility.md) |
| Understand safety, security and privacy guarantees | [11 – Safety, security & privacy](11-safety-security-privacy.md) |
| Test SECOND WORLD itself | [12 – Testing & quality](12-testing-and-quality.md) |
| See the delivery plan and acceptance criteria | [13 – Roadmap](13-roadmap.md) |
| See what changed from the original plan and why | [14 – Plan review & changes](14-plan-review-and-changes.md) |
| Look up a term | [15 – Glossary](15-glossary.md) |
| See the system design as built (layers, errors, timeouts, limits, schemas) | [16 – System design](16-system-design.md) |

## Folder map

```text
docs/
├── README.md                          ← you are here
├── 01-vision-and-principles.md
├── 02-architecture.md
├── 03-engines/
│   ├── README.md                      ← engine catalogue + dependency matrix
│   ├── performance-lab.md
│   ├── stress-capacity-lab.md
│   ├── architecture-inspector.md
│   ├── api-bug-hunter.md
│   ├── adversarial-test-agent.md
│   ├── reliability-lab.md
│   ├── system-model.md
│   ├── experiments.md                 ← What-If + Evolution engines
│   └── evidence-and-history.md        ← Evidence/Reporting, summary (`sw analyze`) + Experiment History
├── 04-data-structures-and-algorithms.md
├── 05-optimization.md
├── 06-environments-and-portability.md
├── 07-libraries.md
├── 08-configuration.md
├── 09-cli-and-api.md
├── 10-plugins-and-extensibility.md
├── 11-safety-security-privacy.md
├── 12-testing-and-quality.md
├── 13-roadmap.md
├── 14-plan-review-and-changes.md
└── 15-glossary.md
```

## The one-paragraph summary

SECOND WORLD is a TypeScript **modular monolith** shipped as one npm package with a CLI. A small **core** (config, safety guard, event bus, evidence store, capability probe, plugin registry) is shared by twelve **engines** that are loaded lazily, only when used. Measurements are deterministic and statistically sound: HDR histograms, coordinated-omission-corrected open-loop scheduling, bootstrap confidence intervals. The tool is fully deterministic: no AI or LLM is used anywhere, and every result comes from measurement, analysis or code. Each finding is labelled as an *observation*, *threshold breach*, *reproduced defect*, *suspected risk* or *hypothesis*, so the report never claims more than the evidence supports. The tool detects its environment at startup (OS, runtime, containers, CPU quota, Docker, proxy, TTY, CI). Features that cannot run are switched off with an explanation instead of crashing.

## Conventions used in these docs

- **MUST / SHOULD / MAY**: requirement levels as in RFC 2119.
- `code` = identifiers, files, commands. *Italics* = defined terms (see glossary).
- Complexity is given in Big-O with `n` = items, `V`/`E` = graph vertices/edges, `k` = buckets.
- Every API shown is a **proposed** interface until the corresponding roadmap milestone ships.
