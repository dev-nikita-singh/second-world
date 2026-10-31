# conduit-api (realistic example app with seeded defects)

A [RealWorld](https://realworld-docs.netlify.app/) "Conduit" style API (users, bearer tokens,
profiles and follows, articles with slugs, tags, comments, favorites, feed, limit/offset pagination)
on plain **node:http** and **node:sqlite** with real transactions. It has no dependencies beyond
Node ≥ 22.19. It is the ground truth for SECOND WORLD's "realistic project" check (wave 7):
**five deliberately seeded defects**, each documented in [`expected-findings.json`](./expected-findings.json)
and marked in the code with a `SEEDED-DEFECT:<id>` comment. Everything else is meant to be correct.
[`openapi.yaml`](./openapi.yaml) describes the **intended, correct** contract.

Do not copy the seeded patterns into real code.

## Run

```bash
npx tsx examples/conduit-api/src/server.ts      # http://127.0.0.1:3100
# env: PORT (default 3100), QUERY_DELAY_MS (simulated DB round trip per query, default 1)
```

Node prints `ExperimentalWarning: SQLite is an experimental feature` on start; that is expected.
In tests, `start(0)` from `src/server.ts` starts it on a random 127.0.0.1 port.

## API

All routes are under `/api` (RealWorld). Auth header: `Authorization: Token <token>` or `Bearer <token>`.

| Route                                                              | Auth              | Notes                                        |
| ------------------------------------------------------------------ | ----------------- | -------------------------------------------- |
| `GET /healthz`                                                     | –                 | liveness                                     |
| `POST /api/users`, `POST /api/users/login`                         | –                 | register / log in → `{ user: { token, … } }` |
| `GET /api/user`, `PUT /api/user`                                   | bearer            | current user                                 |
| `GET /api/profiles/:username`, `POST`/`DELETE …/follow`            | optional / bearer | follow is idempotent                         |
| `GET /api/articles?tag&author&favorited&limit&offset`              | optional          | newest first; `limit` 1–100 (default 20)     |
| `GET /api/articles/feed?limit&offset`                              | bearer            | articles by followed authors                 |
| `POST /api/articles`, `GET`/`PUT`/`DELETE /api/articles/:slug`     | bearer / optional | PUT and DELETE: author only                  |
| `POST`/`DELETE /api/articles/:slug/favorite`                       | bearer            | idempotent per user                          |
| `GET`/`POST /api/articles/:slug/comments`, `DELETE …/comments/:id` | optional / bearer | DELETE: comment author only                  |
| `GET /api/tags`                                                    | –                 |                                              |
| `POST /__test/reset`, `GET /__test/stats`                          | –                 | test hooks: reseed, query counter            |

Seed data (`src/seed.ts`): users `alice`, `bob`, `carol`, `dave`, `erin`, `frank` (email
`<name>@conduit.test`, password `<name>-pass`, fixed tokens `<name>-token`), 60 articles (article
`welcome-to-conduit` by alice has no favorites), tags, follows, favorites and comments.

## Seeded defects

| id                            | Engine                     | Where                          | Reproduce                                                         |
| ----------------------------- | -------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `pagination-off-by-one`       | bugs                       | `src/repositories/articles.ts` | `GET /api/articles?limit=5` → 6 articles                          |
| `n-plus-one-article-list`     | architecture / performance | `src/routes/articles.ts`       | `GET /api/articles` runs 3 queries per article (feed: 6 in total) |
| `slug-header-500`             | bugs                       | `src/routes/articles.ts`       | `GET /api/articles/%F0%9F%98%80` → 500 instead of 404             |
| `delete-article-no-ownership` | bugs (security)            | `src/routes/articles.ts`       | bob `DELETE`s alice's article → 204                               |
| `favorites-count-race`        | bugs                       | `src/repositories/articles.ts` | 5 users favorite one article at once → `favoritesCount` < 5       |

## Finding them with `sw.config.ts`

Work in a copy (reports and history are written next to the config), with the app running on 3100:

```bash
sw --config path/to/copy/sw.config.ts inspect
sw --config path/to/copy/sw.config.ts --yes bugs
```

| Defect                        | Command      | Finding                                                                                                                     |
| ----------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `pagination-off-by-one`       | `sw bugs`    | `bugs/invariant-violated` GET /api/articles (developer invariant [`invariants/page-size.mjs`](./invariants/page-size.mjs))  |
| `n-plus-one-article-list`     | `sw inspect` | ARCH005 at `src/routes/articles.ts` (one finding per query in the loop)                                                     |
| `slug-header-500`             | `sw bugs`    | `bugs/server-error` GET /api/articles/{slug} (boundary: unicode slug)                                                       |
| `favorites-count-race`        | `sw bugs`    | `bugs/race-lost-update` (concurrency test "favorites counter: …": the counter reads are not linearizable with 5 increments) |
| `delete-article-no-ownership` | `sw bugs`    | `bugs/bola` DELETE /api/articles/{slug} (alice creates, bob deletes → 204; PUT is correctly 403)                            |

`sw perf` shows the N+1 as latency: on Windows `GET /api/articles?limit=10` p95 ≈ 300 ms vs the
feed's ≈ 80 ms for the same page size (timer granularity makes each simulated query ≈ 1–15 ms
depending on the OS), but it does not produce a finding that points at the code.
`sw agent`, `sw stress` and `sw reliability run dependency-latency` (fault proxy on 3101 in front of
the API: conduit has no outbound dependency) are expected to report no defects; the reliability run's
`reliability/experiment` summary is a documented observation.

Config notes:
- `bugs.stateful.resources` tells the Bug Hunter that articles are created with `POST /api/articles`
  and addressed by `/article/slug` (the default id pointer `/id` does not exist in RealWorld responses).
- `bugs.values.slug` gives path parameters a real slug; the Bug Hunter only harvests `id` fields.

If you move code, refresh the line numbers:

```bash
node examples/_tools/sync-expected-findings.mjs examples/conduit-api          # update
node examples/_tools/sync-expected-findings.mjs examples/conduit-api --check  # verify
```

## Tests

- `tests/system/conduit.test.ts` starts the app on 127.0.0.1:0 and runs `sw inspect` and `sw bugs`
  (from source) with this folder's `sw.config.ts`; each detectable defect must be found by its engine
  and every other finding must be a documented observation (≈ 2 min).
- The packed-tarball user journey (`npm run build` → `npm pack` → `npm i <tgz>` in a fresh project
  outside the repo → `npx sw doctor/init/inspect/bugs/…`) is in the same file and is **skipped unless
  `SW_SYSTEM_PACK=1`** is set (it builds the package, ≈ 3–4 min):

```bash
SW_SYSTEM_PACK=1 npx vitest run tests/system/conduit.test.ts
```
