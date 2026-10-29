# API Bug Hunter

> Executes tests against a running API and reports **reproducible** deviations from **explicit** expectations.

## 1. Sources of expectations (contracts)

1. **OpenAPI 3.0/3.1** (and Swagger 2.0, converted): paths, params, request/response schemas, status codes, security schemes.
2. **JSON Schema** files.
3. **Inline assertions** in config: status, headers, JSONPath/JMESPath values, response time, custom predicate functions.
4. **Invariants**: developer-defined properties (`stock >= 0`, `GET after PUT returns PUT body`, idempotency).
5. **State models**: finite-state machine of a resource (`created → paid → shipped`), used for stateful tests.

If no contract exists, the engine runs in **discovery mode**. It records observed shapes as a *draft* contract and does **not** report bugs, only observations. Bugs require an explicit expectation.

## 2. Test techniques

| Technique | What it does | Algorithm |
|---|---|---|
| Contract conformance | Validate every response against the schema | Ajv compiled validators (cached per schema) |
| Boundary-value analysis | For numeric `min..max`: `min−1, min, min+1, max−1, max, max+1`. Strings: empty, `minLength±1`, `maxLength±1`, unicode, very long. Arrays: `[]`, `minItems±1` | Derived from schema keywords |
| Equivalence partitioning | One representative per valid/invalid class (type, enum, format, null, missing) | Schema-driven partition table |
| Combinatorial (pairwise) | Covers all value *pairs* across parameters with few cases | IPOG greedy ([DSA §7.3](../04-data-structures-and-algorithms.md#73-pairwise-combinatorial-testing-ipog)) |
| Property-based | Generate many valid inputs from the schema and check invariants. On failure, shrink to the minimal case | `fast-check` arbitraries generated from JSON Schema, integrated shrinking |
| Negative / robustness | Malformed JSON, wrong content-type, huge payloads (bounded), extra fields, injection-shaped strings (safe, non-exploit probes) | Mutation operators |
| Stateful / model-based | Random walks over the resource state machine, then compare against the model | `fast-check` `commands` (model-based testing) |
| Concurrency | Fire K identical/conflicting requests in the same tick (barrier), then verify invariants (last item sold once, idempotency) | Barrier-synchronised burst + linearizability check ([DSA §7.5](../04-data-structures-and-algorithms.md#75-linearizability-checking-concurrency-bugs)) |
| AuthN/AuthZ | Missing/expired/forged token, cross-tenant access (BOLA/IDOR) using **only configured test accounts**, privilege escalation on admin routes | Access matrix: roles × resources × operations |
| Regression replay | Re-run saved failing cases from history | Deterministic replay with seed + recorded requests |

## 3. Reproducibility protocol (what makes a "reproduced-defect")

1. **Known state**: run the `setup` hook (seed fixtures, reset DB via the user's endpoint/script/container snapshot).
2. **Execute** with a fixed seed. Record full request/response (redacted) as a HAR-like artifact.
3. **Assert** against an explicit expectation.
4. **Replay** `n` times (default 3). Classification:
   - fails `n/n` → `reproduced-defect` (deterministic)
   - fails `1..n−1` of n → `reproduced-defect` with `flaky: true` and the observed rate (concurrency bugs are often like this). Re-run up to `maxReplays` to estimate probability with a Wilson confidence interval.
   - fails `0/n` on replay → `observation` (non-reproducible)
5. **Minimise**: shrink the input (fast-check) and the request sequence (delta debugging, [DSA §7.4](../04-data-structures-and-algorithms.md#74-delta-debugging-ddmin)) to the smallest failing case.
6. **Emit**: finding + `curl` / `sw replay <id>` reproduction command, plus `bugs-<fingerprint>/reproduction.har` (HAR 1.2; credentials as `$SW_AUTH_<ROLE>`, cookies and secret-looking values `[REDACTED]`), which opens in browser dev tools and HTTP clients.

## 4. Avoiding false positives

- Status codes listed in `expect` are never failures, e.g. a documented `404`.
- Each schema-violation finding is deduplicated by **fingerprint** (`endpoint + method + JSON pointer of violating keyword + keyword`). 1,000 identical violations become 1 finding with `count: 1000`.
- 5xx from the generator's own timeouts/aborts are classified separately.
- Rate-limit responses (`429`) pause and back off using `Retry-After`. They are not counted as bugs unless asserted.

## 5. Safety

- Only target hosts on the allow-list. Only configured test accounts. No payloads designed to exploit (no real SQLi/RCE). Probes are shape-tests that check input is rejected.
- State-changing methods (`POST/PUT/PATCH/DELETE`) require `environment: "isolated" | "staging"` or explicit `allowMutations: true`.
- Global request budget applies.

## 6. Usage

```bash
sw bugs --target http://127.0.0.1:3000 --openapi ./openapi.yaml --techniques contract,boundary,property --seed 42
sw bugs --concurrency-test "POST /orders" --burst 20 --invariant "./invariants/stock.ts"
sw replay F-01JB8Z...   # re-run a saved failing case
```

### Mixed-operation concurrency tests (config)

A concurrency test can interleave other operations with the burst, so lost updates show up even when every write succeeds. Each `mix` entry says what the request does on the sequential spec model (`as`: `take`, `read`, `inc`, `dec`, `write`, `add`, `remove`, `has`), where the value is (`pointer`, a JSON pointer into the response or request body) and when it runs (`phase`: `before`, `during` (inside the barrier burst) or `after`). The burst plus the concurrent mix requests are capped at 64. The history is checked for linearizability against the stock, counter, register or set model. Responses with an unknown effect (5xx, timeouts, 401/403/408/429) may or may not have happened.

```ts
bugs: {
  concurrency: [{
    operation: "POST /orders", burst: 3, as: "take",
    body: { items: [{ productId: 1, qty: 1 }] }, role: "user",
    mix: [
      { operation: "GET /products/{id}", pathParams: { id: 1 }, as: "read", pointer: "/stock", phase: "before" },
      { operation: "GET /products/{id}", pathParams: { id: 1 }, as: "read", pointer: "/stock", count: 2, phase: "during" },
      { operation: "GET /products/{id}", pathParams: { id: 1 }, as: "read", pointer: "/stock", phase: "after" },
    ],
  }],
}
```

A failing check lists the history in call order (e.g. `take→ok(201) · read→99`) in the finding. The curl reproduction and `sw replay` include the mixed requests.

## 7. Output

Per-endpoint pass/fail matrix, findings with minimal reproduction, flakiness rate, coverage (operations × status codes × techniques exercised), and a draft contract in discovery mode.
