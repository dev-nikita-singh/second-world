# Manual testing guide

You test SECOND WORLD yourself, step by step. **No AI is needed:** SECOND WORLD has no AI inside, and testing means
copying a command, pressing Enter and comparing what you see with this guide.

**How it works:** the project includes practice apps with **bugs hidden in them on purpose**. You know where every
bug is, so you can check:

1. **Does SECOND WORLD find every hidden bug?** (nothing missed)
2. **Does it report anything that isn't a bug?** (no false alarms)
3. **Does it behave well when things go wrong?** (app down, typos, Ctrl+C, a forbidden website)

| Part | App | Users | Hidden bugs | Time |
|---|---|---|---|---|
| [1](#part-1-set-up-once) | set-up | – | – | 5 min |
| [2](#part-2-the-shop-12-hidden-bugs) | **shop**: products, cart, orders, payments | alice, bob, admin | 12 | 20 min |
| [3](#part-3-the-blog-6-users-5-hidden-bugs) | **blog** (Conduit): articles, comments, likes, follows | alice, bob, carol, dave, erin, frank | 5 | 20 min |
| [4](#part-4-when-things-go-wrong) | when things go wrong | – | – | 15 min |
| [5](#part-5-your-score-sheet) | score sheet | – | – | – |
| [6](#part-6-the-browser-ui) | **the browser UI** (`sw ui`): the same tests by clicking | – | – | 20 min |

You don't need to do everything in one go. Each part stands alone after Part 1. **Prefer clicking?** Do Part 1,
start the shop (2.1), then go straight to Part 6.

---

## How to read any result (read this once)

Every run ends with a line like `✖ FAIL (exit 1)` or `✔ PASS (exit 0)` and a findings table.

**FAIL is not "the tool broke".** FAIL means "I found problems in the app". On the practice apps FAIL is the
correct answer, because they really have bugs.

**The exit number:**

| Exit | Meaning |
|---|---|
| 0 | Passed: nothing serious found |
| 1 | Finished and **found problems** |
| 2 | Your command or config is wrong |
| 3 | Blocked by the safety guard (e.g. a target that isn't allowed) |
| 5 | The app being tested is down or broken |
| 70 | **A bug in SECOND WORLD itself: always write this down** |
| 130 | You pressed Ctrl+C |

**Columns in the findings table:**
- **severity:** how bad it is: `critical` > `high` > `medium` > `low` > `info`
- **class:** how sure the tool is:
  - `reproduced-defect`: it made the bug happen for real (strongest)
  - `suspected-risk`: the code looks risky; nothing was run (from `inspect`)
  - `observation`: worth knowing, not necessarily a bug
- **where:** the file and line, or the API route. Ctrl+click a file path to open it; you will see a `SEEDED-DEFECT`
  comment above the hidden bug.

---

## Part 1. Set up (once)

Open the project in VS Code, then open a **PowerShell** terminal (Terminal → New Terminal):

```powershell
cd C:\Users\ASUS\Desktop\Second-world
npm ci
npx tsx src/cli/main.ts doctor
```

✔ **Expected:** a list of ✔ lines ending in `0 problem(s)`. A Docker warning ("daemon not reachable") is fine.

> **Short name:** `sw` in this guide means `npx tsx src/cli/main.ts`. Always run it from the `Second-world` folder.
> If PowerShell says *"running scripts is disabled"*, write `npx.cmd` instead of `npx`.
>
> **Terminals:** use the **+** in the terminal panel to open more. Apps keep running in their own terminal; you type
> tests in another one. **Ctrl+C** stops whatever runs in a terminal.

---

## Part 2. The shop (12 hidden bugs)

Users: **alice** and **bob** are customers (`alice-token`, `bob-token`), **admin** is staff (`admin-token`).

### 2.1 Start it (2 terminals)

**Terminal A**, the payment service:
```powershell
cd C:\Users\ASUS\Desktop\Second-world
npx tsx examples/payments-fake/src/server.ts
```

**Terminal B**, the shop:
```powershell
cd C:\Users\ASUS\Desktop\Second-world
npx tsx examples/shop-express/src/server.ts
```

**Terminal C**, where you type tests:
```powershell
cd C:\Users\ASUS\Desktop\Second-world
Invoke-RestMethod http://127.0.0.1:3000/products/1
```

✔ **Expected:** product 1. Look at `price : 7.50`. The API promises a number, but the app sends the text `"7.50"`.
That's hidden bug `schema-drift-price`; let's see if SECOND WORLD finds it too.

### 2.2 Test: read the code (`inspect`), 5 seconds

```powershell
npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts inspect
```

**What it does:** reads the source code without running it, looking for risky patterns.

✔ **Expected:** `✖ FAIL (exit 1)`, **6 findings**:

| Severity | Finding (short) | Hidden bug? |
|---|---|---|
| high | Outbound HTTP call without timeout, `payments-client.ts` | ✅ `no-timeout-outbound` |
| high | Retry without max attempts or backoff, `payments-client.ts` | ✅ `unbounded-retry` |
| medium | Database query inside a loop (N+1), `GET /products` | ✅ `n-plus-one-reviews` |
| medium | Database query inside a loop, `placeOrder` | ⚪ not a bug (one read per order line is fine) |
| medium | Module dependency cycle, `inventory.ts` | ✅ `module-cycle` |
| medium | Synchronous heavy work in request path, `login` | ✅ `sync-crypto-login` |

You will also see 3 `WARN ... looks like a secret` lines. That's correct: the practice config has its test tokens
written in, and SECOND WORLD warns that real secrets belong in environment variables.

### 2.3 Test: hunt API bugs (`bugs`), 15 seconds

```powershell
npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts bugs
```

**What it does:** sends hundreds of tricky requests: wrong values, edge values, **bob trying alice's things**, the
same order twice, 5 orders at the exact same moment. Then it checks every answer against the API description.

✔ **Expected:** `✖ FAIL (exit 1)`, **8 findings**:

| Severity | Finding (short) | Hidden bug? |
|---|---|---|
| critical | BOLA: another user's object is accessible, `GET /orders/{id}` | ✅ `bola-orders` (bob reads alice's orders) |
| high | Race / lost update, `POST /orders` (last item: orders vs stock reads) | ✅ `stock-race` (the last item is sold 5 times) |
| high | Race / lost update, `POST /orders` (same Idempotency-Key, concurrent) | ✅ `idempotency-key-race` |
| high | Idempotency-Key ignored, `POST /orders` | ✅ `idempotency-ignored` |
| medium | Response does not match the contract schema, `GET /products/{id}` (/price) | ✅ `schema-drift-price` |
| medium | Server error (5xx) on a boundary value, `POST /cart/items` | ✅ `boundary-500` |
| medium | Server error (5xx) on a boundary value, `POST /orders` | ✅ `boundary-500` |
| info | Invalid input accepted, `GET /products` (include) | ⚪ not a bug (documented) |

### 2.4 Prove the bugs yourself, with several users

The tool says bob can read alice's orders. Don't trust it; check it with your own hands:

```powershell
# alice orders something
$o = Invoke-RestMethod -Method Post http://127.0.0.1:3000/orders -Headers @{ authorization = "Bearer alice-token" } -ContentType "application/json" -Body '{"items":[{"productId":1,"qty":1}]}'
$o.id

# alice reads her own order (fine)
Invoke-RestMethod "http://127.0.0.1:3000/orders/$($o.id)" -Headers @{ authorization = "Bearer alice-token" }

# bob reads alice's order (should be refused with 404; it isn't, so this is the security bug)
Invoke-RestMethod "http://127.0.0.1:3000/orders/$($o.id)" -Headers @{ authorization = "Bearer bob-token" }

# nobody logged in (should be refused with 401)
Invoke-RestMethod "http://127.0.0.1:3000/orders/$($o.id)"

# bob opens the admin page (should be refused with 403)
Invoke-RestMethod http://127.0.0.1:3000/admin/stats -Headers @{ authorization = "Bearer bob-token" }

# admin opens the admin page (fine)
Invoke-RestMethod http://127.0.0.1:3000/admin/stats -Headers @{ authorization = "Bearer admin-token" }

# quantity 0 (should be refused with 400; the server crashes with 500 instead)
Invoke-RestMethod -Method Post http://127.0.0.1:3000/cart/items -Headers @{ authorization = "Bearer alice-token" } -ContentType "application/json" -Body '{"productId":1,"qty":0}'
```

✔ **Expected:** bob sees `userId : u_alice` (**bug**). Nobody-logged-in gets a **401** error and bob on the admin page
gets a **403** error (**correct**: the app does those right, and the tool did not complain about them). Quantity 0 gives
a **500** error (**bug**).

That's the point of manual testing: the tool flagged exactly the wrong ones and left the correct ones alone.

### 2.5 Test: load test (`perf`), 25 seconds

```powershell
npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts -f tty,html perf
```

**What it does:** acts like many shoppers at once (50 visits per second for 20 seconds) and measures speed.

✔ **Expected:** `✔ PASS (exit 0)`, about **1,800 requests, 0 failed**, both thresholds ✔. Your numbers will differ
from anyone else's; that's normal.
- **p50** = typical speed (half the requests were faster). **p95** = slow-end speed (95% were faster).
- In the endpoint table, `GET /products` is much slower at p95 (~145 ms) than `GET /products/{id}` (~16 ms). That's
  the N+1 bug from `inspect` showing up as slowness.
- Near the end a line says `report: C:\...\report.html`. Ctrl+click it to open the report in your browser.

### 2.6 Test: break the payment service on purpose (`reliability`), 25 seconds

This test needs the shop to send payment calls **through SECOND WORLD** (port 4011), so it can inject failures.

1. In **Terminal B**: press **Ctrl+C**, then:
   ```powershell
   $env:PAYMENTS_URL = "http://127.0.0.1:4011"
   npx tsx examples/shop-express/src/server.ts
   ```
2. In **Terminal C**:
   ```powershell
   npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts --approve-disruptive reliability run dependency-5xx
   ```

**What it does:** while customers order, it makes payments fail for a few seconds, watches the shop, then removes
the failure and checks the shop recovers. It does this twice.

✔ **Expected:** `✖ FAIL (exit 1)`, findings each confirmed in **2/2** runs:

| Severity | Finding (short) | Hidden bug? |
|---|---|---|
| high | Duplicate operations: more orders created than customers asked for | ✅ `idempotency-ignored` (customers charged twice) |
| high | Retry storm: ~280× calls to payments per request | ✅ `unbounded-retry` |
| medium | No circuit breaker | ✅ `no-circuit-breaker` |
| info | dependency-5xx on payments: summary | ⚪ summary, not a bug |

The **Invariants** table should say `orders-per-operation ... VIOLATED`, which proves the double orders.

3. Optional, a second kind of failure (payments become **slow** instead of broken):
   ```powershell
   npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts --approve-disruptive reliability run dependency-timeout
   ```
   ✔ **Expected** among the findings: **outbound call has no timeout** (✅ `no-timeout-outbound`), plus the duplicate
   operations and no-circuit-breaker findings again.

4. **Clean up:** in Terminal B press Ctrl+C, run `Remove-Item Env:PAYMENTS_URL`, and start the shop normally again
   (`npx tsx examples/shop-express/src/server.ts`).

> **Try the mistake on purpose (a bug found while writing this guide, now fixed):** skip step 1 (start the
> shop normally, without `PAYMENTS_URL`) and run the same command. The failure goes into a connection the shop
> never uses. ✔ **Expected:** `✖ FAIL (exit 1)` and a limitation `fault-not-exercised` that says "The fault
> never reached the app … received 0 calls" and how to fix the wiring. Before the fix this wrongly said
> **PASS (exit 0)**.

### 2.7 Test: history and reports

```powershell
npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts history list
npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts analyze --last
npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts report --last -f html,md
```

✔ **Expected:** a table of every run you did (inspect, bugs, perf, reliability) with its status and number of
findings; a short summary of the last run; and a new HTML and Markdown report.

**Compare two load tests:** run the `perf` command from 2.5 a second time, run `history list` again, then compare the
two perf run IDs (copy them from the list):
```powershell
npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts history diff <first-perf-id> <second-perf-id>
```
✔ **Expected:** the two runs side by side with "no significant change" (exit 0), because nothing changed in the app.

**Re-run one bug (replay):** the `bugs` output has a **Reproductions** section. Every finding has a fingerprint (the
`bugs-xxxxxxxx` names in the `artifacts:` line). Take one, e.g. `bugs-68e3d7d1`, and:
```powershell
npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts replay 68e3d7d1
```
✔ **Expected:** it replays that one bug and says it still reproduces (exit 1). After someone fixes the bug, the same
command would give exit 0. That's how you check a fix.

---

## Part 3. The blog (6 users, 5 hidden bugs)

A blog API like Medium: articles, comments, likes ("favorites"), follows. Six users: **alice, bob, carol, dave,
erin, frank** (tokens `alice-token`, `bob-token`, …). This part tests what happens when **many users act at the same
time** and **users try to change each other's things**.

Stop the shop first (Ctrl+C in Terminals A and B). Then in **Terminal B**:
```powershell
cd C:\Users\ASUS\Desktop\Second-world
npx tsx examples/conduit-api/src/server.ts
```
(An `ExperimentalWarning: SQLite` line is normal.)

### 3.1 Prove the multi-user rules by hand first

```powershell
$h = @{ authorization = "Bearer alice-token" }
# alice writes an article
$a = Invoke-RestMethod -Method Post http://127.0.0.1:3100/api/articles -Headers $h -ContentType "application/json" -Body '{"article":{"title":"Alice test","description":"d","body":"b","tagList":["t"]}}'
$slug = $a.article.slug; $slug

# bob tries to EDIT alice's article (correct app: 403 refused)
Invoke-RestMethod -Method Put "http://127.0.0.1:3100/api/articles/$slug" -Headers @{ authorization = "Bearer bob-token" } -ContentType "application/json" -Body '{"article":{"title":"hacked"}}'

# bob tries to DELETE alice's article (correct app: 403; this app lets him = bug)
Invoke-RestMethod -Method Delete "http://127.0.0.1:3100/api/articles/$slug" -Headers @{ authorization = "Bearer bob-token" }
Invoke-RestMethod "http://127.0.0.1:3100/api/articles/$slug"   # now 404: the article is gone

# ask for 5 articles (correct: 5; this app gives 6 = bug)
(Invoke-RestMethod "http://127.0.0.1:3100/api/articles?limit=5").articles.Count

# carol likes an article twice (correct: still counted once)
$c = @{ authorization = "Bearer carol-token" }
Invoke-RestMethod -Method Post http://127.0.0.1:3100/api/articles/welcome-to-conduit/favorite -Headers $c | Out-Null
(Invoke-RestMethod -Method Post http://127.0.0.1:3100/api/articles/welcome-to-conduit/favorite -Headers $c).article.favoritesCount

# reset the blog to its starting data
Invoke-RestMethod -Method Post http://127.0.0.1:3100/__test/reset
```

✔ **Expected:** bob's edit → **403 error (correct)**; bob's delete **works (bug)** and the article is gone; `limit=5`
gives **6 (bug)**; carol's double like → **1 (correct)**.

The 5th bug needs 5 users liking at the **exact same millisecond**. You can't click that fast; the tool can.

### 3.2 Test: read the code and hunt bugs

```powershell
npx tsx src/cli/main.ts --config examples/conduit-api/sw.config.ts inspect
npx tsx src/cli/main.ts --config examples/conduit-api/sw.config.ts --yes bugs
```
(`--yes` allows the test to create and delete things in the blog; it resets the data afterwards.)

✔ **Expected:** both say `✖ FAIL (exit 1)` and together find all 5:

| Hidden bug | Command | Finding (short) |
|---|---|---|
| `n-plus-one-article-list` | inspect | Database query inside a loop, `src/routes/articles.ts` (may be listed more than once, one per query) |
| `pagination-off-by-one` | bugs | Invariant violated, `GET /api/articles` (page-size) |
| `slug-header-500` | bugs | Server error, `GET /api/articles/{slug}` (an emoji in the address) |
| `delete-article-no-ownership` | bugs | BOLA, `DELETE /api/articles/{slug}` (bob deletes alice's article) |
| `favorites-count-race` | bugs | Race / lost update, favorites counter (**5 users like at once, count ends below 5**) |

Anything **else** at `high` or `critical` is a false alarm: write it down.

### 3.3 Tests that should find **nothing** (also important)

A good tool stays quiet when there is nothing to find. On this blog these four should report **no bugs**:

```powershell
npx tsx src/cli/main.ts --config examples/conduit-api/sw.config.ts perf
npx tsx src/cli/main.ts --config examples/conduit-api/sw.config.ts stress
npx tsx src/cli/main.ts --config examples/conduit-api/sw.config.ts --yes agent
npx tsx src/cli/main.ts --config examples/conduit-api/sw.config.ts --approve-disruptive reliability run dependency-latency
```

| Command | What it does | ✔ Expected |
|---|---|---|
| `perf` | normal load | PASS, ~0 errors. `GET /api/articles` is slower than the feed (the N+1 again, shown as time) |
| `stress` | load in steps of 5, 10, 20 users, 5 s each | a table per step and a "tested capacity" line; no crash |
| `agent` | invents extra attack ideas (other users' data, wrong order of steps, …) for up to 90 s | no defects |
| `reliability ... dependency-latency` | makes every request 300 ms slower for a few seconds | only the `info` summary finding |

---

## Part 4. When things go wrong

A tool must also behave well when **you** or **the app** make mistakes. For each row: run it, check the exit
number, and check the message makes sense to you.

| # | Scenario | Command | ✔ Expected |
|---|---|---|---|
| 1 | App is **not running** (stop it first) | `npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts bugs` | clear "not reachable" message, **exit 5**, no crash text |
| 2 | **Typo** in a command | `npx tsx src/cli/main.ts inspct` | "unknown command", suggests `inspect`; exit not 70 |
| 3 | **Wrong config path** | `npx tsx src/cli/main.ts --config nope.ts perf` | says the file is missing, **exit 2** |
| 4 | **A real website** (must be refused) | `npx tsx src/cli/main.ts perf https://example.com` | refused by the safety guard, **exit 3**. Nothing is sent to the site |
| 5 | **Ctrl+C** in the middle | start the shop `perf` from 2.5, press Ctrl+C after 5 s | stops within a second or two, **exit 130**, says the run was interrupted |
| 6 | **Ctrl+C twice** fast | same, press Ctrl+C twice | stops immediately; no `.tmp` files left in `examples\shop-express\.second-world` |
| 7 | **Stricter pass rule** | shop `inspect` with `--fail-on critical` added before `inspect` | now **exit 0**, because there are high findings but no critical |
| 8 | **Other report formats** | shop `bugs` with `-f md,sarif,junit,html` added before `bugs` | 4 report files appear in the printed folder |
| 9 | **Dry run** (check only, send nothing) | shop `perf` with `--dry-run` added after `perf` | validates the config and says what it *would* do; sends no requests |
| 10 | **A brand-new project** | `mkdir $env:TEMP\swnew; cd $env:TEMP\swnew; npx --prefix C:\Users\ASUS\Desktop\Second-world tsx C:\Users\ASUS\Desktop\Second-world\src\cli\main.ts init` | writes a `sw.config.ts` and lists what it could not detect. `cd C:\Users\ASUS\Desktop\Second-world` afterwards |
| 11 | **History is intact** | `npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts history verify` | all runs verified, **exit 0** |
| 12 | **Help** | `npx tsx src/cli/main.ts --help` and `npx tsx src/cli/main.ts bugs --help` | every command and option explained |

**Any exit 70, any long red "stack trace", or any message you don't understand = write it down.**

---

## Part 5. Your score sheet

**Shop:**

| # | Hidden bug | Found by | ☐ |
|---|---|---|---|
| 1 | `n-plus-one-reviews` | inspect | ☐ |
| 2 | `no-timeout-outbound` | inspect, reliability timeout | ☐ |
| 3 | `sync-crypto-login` | inspect | ☐ |
| 4 | `module-cycle` | inspect | ☐ |
| 5 | `unbounded-retry` | inspect, reliability 5xx | ☐ |
| 6 | `stock-race` | bugs | ☐ |
| 7 | `idempotency-ignored` | bugs, reliability | ☐ |
| 8 | `bola-orders` | bugs | ☐ |
| 9 | `schema-drift-price` | bugs | ☐ |
| 10 | `boundary-500` | bugs | ☐ |
| 11 | `idempotency-key-race` | bugs | ☐ |
| 12 | `no-circuit-breaker` | reliability | ☐ |

**Blog:**

| # | Hidden bug | Found by | ☐ |
|---|---|---|---|
| 13 | `n-plus-one-article-list` | inspect | ☐ |
| 14 | `pagination-off-by-one` | bugs | ☐ |
| 15 | `slug-header-500` | bugs | ☐ |
| 16 | `delete-article-no-ownership` | bugs | ☐ |
| 17 | `favorites-count-race` | bugs | ☐ |

**Other checks:**

| Check | ☐ |
|---|---|
| No false alarms (nothing at high/critical that isn't in the tables) | ☐ |
| Part 3.3: perf, stress, agent, reliability found nothing on the blog | ☐ |
| Part 4: all 12 scenarios behaved as expected | ☐ |
| 2.6 "mistake on purpose" gives FAIL with `fault-not-exercised`, not PASS | ☐ |
| Part 6: the UI did everything in its checklist | ☐ |

**17/17 found, no false alarms, Part 4 and Part 6 all as expected = ready to publish.**

### What to write down when something is off

For anything unexpected, note: **the command**, **the exit number**, **what you expected**, **what you got** (copy
the last ~20 lines of output). Messages that confused you count too: if you didn't understand a message, a user
won't either.

---

## Bonus: a real app with no hidden bugs

After all of the above, try the real open-source app you forked: `C:\Users\ASUS\Desktop\sw-targets\expense-tracker-api-fork`
(start it with `npm start` in that folder; its SECOND WORLD config is in `C:\Users\ASUS\Desktop\sw-targets\expense-sw`).
Nobody planted bugs there, so **0 findings** is the expected answer, and any finding needs a closer look: either a
real bug in that app, or a false alarm in SECOND WORLD.

---

## Part 6. The browser UI

The same tests, by clicking. Start the shop first (Part 2.1, Terminals A and B). Then in **Terminal C**:

```powershell
npx tsx src/cli/main.ts --config examples/shop-express/sw.config.ts ui
```

✔ **Expected:** the terminal prints `SECOND WORLD UI → http://127.0.0.1:4777/#t=…` and your browser opens the
**Dashboard**. (The first start from source takes a few seconds: it builds the UI.) Leave this terminal running;
**Ctrl+C** in it stops the UI.

Work through this checklist. Each line: what to do → what you should see.

| # | Do | ✔ Expected |
|---|---|---|
| 1 | Look at the top bar | `shop-express` and two pills: **api** with a green dot, **payments** with a grey dot (dependencies are not health-checked) |
| 2 | Stop the shop (Ctrl+C in Terminal B), wait 10 s | The **api** dot turns red and the Dashboard shows "api is not reachable". Start the shop again: green within 10 s |
| 3 | **New test** → **Code inspection** → **Start test** | A live page with the output scrolling, then "Finished and found problems · exit 1". Click **See the results**: the same 6 findings as in Part 2.2 |
| 4 | In that run, click the **high** "Outbound HTTP call without timeout" finding | A side panel: what happened, how to fix, where (`src/payments-client.ts:22`). **Esc** closes it |
| 5 | **New test** → **API bug hunt** → **Start test** | After ~15 s: the 8 findings from Part 2.3. Open the **critical BOLA** finding: it shows two `curl` commands and a **Replay this bug** button |
| 6 | Click **Replay this bug** | A short run that ends "Still reproduces: not fixed yet · exit 1" |
| 7 | **New test** → **Load test** → set Duration `30s` → **Start test**, then click **Stop** after ~5 s | It stops within a second or two: "Stopped · exit 130". The output says "stopping gracefully" |
| 8 | **Load test** again with Duration `10s`, let it finish, open the run | Four tiles (requests, throughput, p50/p95, error rate), a response-time chart, pass rules, a per-endpoint table |
| 9 | **New test** → **Failure test** → pick "Dependency returns 5xx" → **Start test** | A confirmation dialog explains it breaks dependencies on purpose. **Cancel** = nothing runs. (To really run it, restart the shop with `PAYMENTS_URL` as in Part 2.6 first; otherwise you get the `fault-not-exercised` result from 2.6.) |
| 10 | **New test** → **Load test** → type `abc` in Requests per second → **Start test** | A red "Enter a number" under the field; nothing starts |
| 11 | Any test → **Dry run** | Ends "Plan is valid: nothing was sent · exit 0"; no new run in **Runs** |
| 12 | **Runs**: filter "Load test", tick two load-test runs → **Compare 2 runs** | A metrics table before → after and the findings that are new / fixed / still there |
| 13 | **Findings** | Every finding from your runs; switch **Open / All**, filter by severity, search `orders` |
| 14 | A run page → **Download** → HTML (and the other formats) | A file `second-world-<run id>.html` downloads and opens as a full report |
| 15 | **Settings** | Your config with tokens masked, the `doctor` checks, the theme switch (try Light / Dark) |
| 16 | Press **Tab** repeatedly on any page | A visible focus outline moves through links and buttons in a sensible order |
| 17 | Copy the page address (it no longer has `#t=…`) and open it in a **private window** | "This link has expired": a new browser session needs the link printed in the terminal (the private key) |
| 18 | Ctrl+C in Terminal C and keep the browser tab open (don't reload) | Within 10 s the page shows a red banner "SECOND WORLD UI stopped" telling you to start `sw ui` again |

**Anything that looks wrong, confusing or slow:** take a screenshot and note which row.
