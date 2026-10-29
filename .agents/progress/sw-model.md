# Progress: sw-model

## Done
- Unit 1+2+3 code written, tsc clean for my paths:
  - src/adapters/telemetry/{otlp,prometheus,receiver,index}.ts — OTLP/JSON (+JSONL, legacy keys, base64 ids, ns strings → µs),
    Prometheus text parser (+histogram grouping/quantile), OTLP/HTTP JSON receiver (415 for protobuf, gzip, bounded).
  - src/engines/model/: types, similarity (Jaro-Winkler + normalizeName), confidence (noisy-OR per family, AI cap), traces
    (span tree, critical path iterative, peerOf), sources/{observation,architecture,openapi,config,traces,runtime}.ts,
    resolve (union-find rules), build (buildModel), graph (ModelGraph queries), diff, export (DOT/Mermaid/canonical JSON),
    snapshot (save/load), schema (zod ModelInputSchema), index (modelEngine + re-exports).
  - Fixtures: tests/fixtures/model/{shop-traces.json, payments-traces.jsonl, generate-traces.mjs, shop-config/{docker-compose.yml,.env.example}}.
  - Smoke on shop-express: payments = ONE node (arch external:payments + PAYMENTS_URL env x2 + compose payments + trace peer
    payments + trace svc payments-fake); Db merged (proposed, exact name); dominant POST /orders → payments-fake 82%.

## Tests (all green, tsc clean for my paths, biome clean)
- Unit tests/unit/model: 56 (basics 11, telemetry 6, traces 7, resolve 12, config 6, model 14).
- Integration tests/integration/model/shop-express.test.ts: 9 (shop-express model ground truth, receiver → rebuild → diff, receiver limits).
- Merge accuracy on fixtures: payments (6 observations: arch external, 2× env, compose, trace peer, trace svc) → 1 node;
  shop (primary, compose, trace svc) → 1 node; Db (arch heuristic + trace db spans) → 1 node (proposed merge);
  13/13 static routes matched to OpenAPI (10) and trace (3) routes; 0 false merges.

## Status: DONE — CONTRACTS.md "sw-model" READY (with CLI wiring + reporting notes); main messaged.

## Gaps / follow-ups
- OTLP protobuf unsupported (JSON only); exponential histograms parsed but not used for p95.
- No HTML/Cytoscape view (spec §5) — reporting owner could render ModelData; CLI `sw model build|show|diff` not wired (sw-core).
- Static analysis is TS/JS only (via Architecture Inspector); handler-level trace ↔ code mapping not done.
- Prometheus rps needs two scrapes; OTLP metrics only http.server.(request.)duration histograms mapped.
- Receiver keeps draining oversized bodies (localhost only) before answering 413.

## Decisions
- Layout: src/adapters/telemetry (wire formats only); src/engines/model/** (+ sources/*).
- Confidence: max per source family (static+static-heuristic = one family), noisy-OR across families; AI never raises confidence
  (cap = noisy-OR of non-AI families); AI-only = ≤ 0.2 + `hypothesis: true`. Fuzzy merges multiply node confidence by 0.6–0.9
  (0.9 at jw=1); fuzzy merges with AI-only groups do not lower confidence.
- Static evidence: arch confidence < 0.6 / heuristic → "static-heuristic" 0.5, else "static" 0.75. Performance/metrics/experiments 0.9.
- Resolution order: explicit links (trace-link, k8s-selector) → host-port → service-name → env-url → name-similarity → routes
  (route-signature within the resolved service). Kind compatibility checked per group at union time. Fuzzy never on IP/host:port
  names, never between groups with disjoint known hosts, never between two traced services; names < 4 chars must match exactly.
- localhost/0.0.0.0/::1/host.docker.internal normalised to 127.0.0.1 for host:port.
- Primary service = serviceName ?? package.json name ?? project folder; OpenAPI + arch routes belong to it (key app:primary).
- Node ids: `<kind>:<canonical name>` (canonical name priority: primary > trace service.name > compose/k8s > … > arch);
  routes `route:<service>:<METHOD> <path>` with OpenAPI-style `{param}`; collisions get `#2`.
- "depends" edges are folded into a more specific edge between the same pair.
- Env values never stored: only scheme://host:port of URL-like values; plain host:port only for address-like keys, never for secret-like keys.
- components detail collapses internal functions into route → dependency edges (BFS over arch call graph); detail "full" keeps them.

## Wave 4

### Checkpoint 1 — AI hypothesis source removed (DONE)
- types.ts: dropped "ai" from SourceKind/CoverageSource, ModelEvidence.ai, ModelNode/ModelEdge.hypothesis, stats.hypotheses,
  Hypothesis type. Nothing deterministic set `hypothesis`, so it is gone entirely (Finding.classification "hypothesis" is unrelated, kept).
- confidence.ts: plain noisy-OR of best-per-family × multiplier; CombineResult = { confidence }.
- resolve.ts: no ai: key / aiOnly fuzzy-merge exception. schema.ts/build.ts: no `hypotheses` input (strict schema rejects it),
  no MODEL_AI_HYPOTHESES, no sources.ai label. sources/runtime.ts: fromHypotheses deleted.
- export.ts: no dashed hypothesis styling (low confidence < 0.6 stays dotted).
- reporting/model-render.ts: "hypothesis (AI only…)" note → "low confidence, unconfirmed" for confidence < 0.6; AI stats row removed.
  cli/commands/model.ts: "(hypothesis)" suffix removed. Fixture redis node/edge now static-heuristic 0.5;
  tests/unit/reporting/model.test.ts 4 assertions updated accordingly (outside my paths, forced by the fixture change).
- grep for "ai"/aiOnly/ai: in model/reporting/tests clean; tsc clean; model+reporting tests 219 green.

### Checkpoint 2 — OTLP protobuf (DONE)
- src/adapters/telemetry/otlp-proto.ts (new): bounded wire decoder (varint/I64/LEN/I32, unknown fields skipped, groups +
  wire 6/7 + field 0 rejected, 10-byte varint cap, length checks, maxBytes 256MiB, maxDepth 64 (recursion only to that
  depth), maxSpans skip+count). Decodes ExportTrace/MetricsServiceRequest (+ deprecated field 1000) into the OTLP/JSON
  shape, then parseOtlp → everything downstream shared. Field numbers listed in the header (opentelemetry-proto).
  detectOtlpSignal (Span fixed64 7/8 / varint 6 vs Metric LEN 5/7/9/10/11); isOtlpProtobufFile (.pb/.binpb/.protobuf/.bin,
  or a control byte in the first 64 KiB); encodeRpcStatus. Re-exported from telemetry/index.ts and model/index.ts.
- build.ts: --traces files read as bytes, protobuf or JSON per isOtlpProtobufFile; errors → MODEL_OTLP_UNREADABLE.
  MODEL_OTLP_PROTOBUF base limitation removed.
- receiver.ts: application/x-protobuf accepted on /v1/traces + /v1/metrics (signal from path, gzip/deflate);
  200 = empty protobuf body; 400/413 = google.rpc.Status (3 / 8). Other content types → 415.
- cli/main.ts --traces help updated. docs/03-engines/system-model.md never said protobuf was unsupported → no sw-docs message.
- CONTRACTS.md sw-model rows updated (hypotheses input removed, protobuf API, rendering note).
- Tests: tests/unit/model/otlp-pb-encoder.ts (independent encoder), otlp-proto.test.ts (17: attr types, fixtures, unknown
  fields, legacy 1000, maxSpans, metrics packed/unpacked/exp-hist, detection, sniffing, truncation sweep, bad tags/wire/
  varints/lengths/packed, size + depth limits, 4000-case deterministic fuzz, JSON-vs-pb identical model, unreadable file);
  tests/integration/model/otlp-protobuf.test.ts (2: receiver protobuf traces+gzip+metrics → identical model; clean errors).
  shop-express.test.ts: garbage protobuf now 400 (was 415).
- Totals: tests/unit/model 73, tests/integration/model 11 (84 green); + reporting/examples 319 green overall; tsc clean; biome clean.

## Status: Wave 4 DONE
## Gaps
- CLI `--receive` still prints OTEL_EXPORTER_OTLP_PROTOCOL=http/json hint (src/cli/commands/model.ts, not mine): now optional.
- Exponential histogram buckets still not decoded/used (count/sum only, same as JSON). Gzipped .pb files not auto-detected.
- Protobuf input is fully decoded into memory (bounded by maxBytes / receiver maxBodyBytes), not streamed.
