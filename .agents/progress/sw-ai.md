# Progress: sw-ai

## Status: DONE (all deliverables READY in CONTRACTS.md "sw-ai" section)

## Done
- src/adapters/ai/{types,http,resilience,pricing,anthropic,openai,ollama,factory,index}.ts: providers over fetch, retry (full jitter + Retry-After), circuit breaker, pricing, privacy policy, env-only keys.
- src/engines/ai/{config,knapsack,relevance,numbers,redaction,sources,evidence,schema,prompt,verify,cache,deterministic,engine,render,index}.ts.
- Tests: tests/unit/ai (8 files, 66 tests: knapsack property, redaction property, verify, numbers, schema+injection, evidence, engine (ceilings/cache/dry-run/localOnly/retry/fallback), adapters (wire formats, retry, breaker, policy, pricing)); tests/integration/ai (2 files, 10 tests: Anthropic tool_use, OpenAI json_schema, Azure-style compatible, Ollama format, 429+Retry-After, 529 + non-JSON body, malformed model JSON → retry, timeouts; e2e over real runPerformance (child calibrated server) + inspectArchitecture(shop-express)).
- tsc clean for my paths; biome clean for my paths.
- CONTRACTS.md sw-ai section + request to main (extend core AiSchema). sw-agent messaged with import paths.

## Next (gaps / follow-ups)
- main/sw-core: extend core `AiSchema` (strict) with engine options; wire `sw analyze` (notes in CONTRACTS).
- reporting owner: render `aiBlocks(data)` when `isAIData(result.data)`.
- Not done: streaming, provider tokenizer use is opt-in only (`useProviderTokenCounter` parsed but not yet wired into packing), golden-set eval (hit@3, cassettes), Evolution "candidate fix diffs".

## Decisions
- Module layout: adapters = wire formats + HTTP + retry/breaker/pricing/factory; engine = packer, prompt, verification, cache.
- Anthropic: raw fetch to `/v1/messages`, `anthropic-version: 2026-10-21` (config `anthropicVersion`). Default model `claude-opus-5-5` lives in DEFAULT_MODELS (config), not in logic. Structured output default `output_config.format = {type:"json_schema"}`; alt `structuredMode:"tool"` = strict tool `submit_analysis` + `tool_choice:auto` (forced tool_choice 400s on current models). No `temperature` sent to Anthropic (rejected by API version 2026-10-21).
- The wire JSON Schema is handwritten and strict-safe. `recommendedExperiments[].input` is a JSON string on the wire; Zod parses it to an object. Citations are normalised ("[e3]" → "E3").
- The core AiSchema is strict and lacks the extras → engine-side lenient `AIOptionsSchema`; `input.ai` overrides `ctx.config.ai`.
- Policy violations and token/cost ceilings throw SafetyError before any network I/O. The evidence budget is derived from min(maxTokens, maxContext, affordable-by-cost) minus prompt overhead and output reserve. The validation retry is skipped (limitation) if it would breach ceilings.
- Provider failures after retries → status "error" + deterministic fallback + limitation (message redacted).
- Redaction: core redactor + standalone high-entropy tokens (≥24 chars, ≥4.2 bits, letters+digits; path segments judged separately; pure-hex hashes kept) + emails + non-loopback IPv4 + env vars named *KEY/TOKEN/SECRET/PASSWORD* + resolved config secrets + the provider key. The question is redacted too (a leak found by the property test).
- Mandatory items: the overview + up to 8 items with question coverage ≥ 0.5. The budget is never exceeded, even by mandatory items (dropped ones are reported).
- Numeric check: ±1%, with %↔ratio and s↔ms variants. It skips bare integers 0..10, dates, versions, p95/E3/5xx identifiers. Uncited claims are kept with confidence halved + `uncited: true` (or dropped with `uncitedClaims: "drop"`).
- Cache key = sha256(provider, model, evidence version, maxOutputTokens, system, user, schema). TTL uses wall-clock `Date.parse(clock.isoNow())`.
- Prices: the Anthropic table comes from the claude-api skill (cached 2026-10-06). Ollama = 0. OpenAI/compatible = "unknown" unless `ai.prices` is set.
