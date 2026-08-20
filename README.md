# x-tweet-scraper

Browserless X (Twitter) scraper for Apify. HTTP only against X's internal GraphQL,
guest-token auth, a strict output contract, and a free-tier gate whose source of
truth is a server the runner does not control.

- **Repo:** https://github.com/ramyx/x-tweet-scraper
- **Actor:** https://console.apify.com/actors/bEAaMlZm4LDT5RQuh (`bEAaMlZm4LDT5RQuh`)
- **Tests:** 170, all offline against captured fixtures

---

## What this build does, and does not

| Surface | Operation | Status |
|---|---|---|
| Tweets by author | `UserTweets` / `UserTweetsAndReplies` | ✅ implemented |
| A single tweet by id | `TweetResultByRestId` | ✅ implemented |
| A user profile by handle | `UserByScreenName` | ✅ implemented |
| Free-text search | `SearchTimeline` | ❌ **not implemented — auth-walled to guests** |

All three required surfaces work with a plain guest token and **no feature flags at
all**. `searchTerms` is rejected at input validation with an explanation, rather
than accepted and silently returning nothing. The evidence for that decision is in
[§ Search](#search-what-i-tried-and-why-it-is-walled).

No browser engine is involved, and that is machine-checked: `test/no-browser.test.ts`
parses `package-lock.json` and fails if playwright, puppeteer, selenium or friends
appear anywhere in the tree.

---

## Quick start

```bash
npm ci && npm run check      # typecheck + lint + 170 tests, no network
```

Full instructions — local, Apify and the entitlements service — are in
[docs/SETUP.md](docs/SETUP.md).

### Example input

```json
{
  "fromUsers": ["apify"],
  "hashtags": ["buildinpublic"],
  "since": "2026-01-01",
  "language": "en",
  "minLikes": 25,
  "onlyVerified": false,
  "mediaType": "any",
  "includeReplies": false,
  "includeRetweets": false,
  "sortBy": "latest",
  "maxResults": 500,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

### Example output

Every item conforms exactly to the schema in §5 of the brief: all 16 keys present,
missing values `null` (never omitted, never `undefined`), `id` a string, timestamps
ISO-8601 UTC.

```json
{
  "id": "2090100861577875506",
  "url": "https://x.com/apify/status/2090100861577875506",
  "text": "Prague's first meetup for marketers who build with AI. …",
  "lang": "en",
  "createdAt": "2026-08-19T15:37:32.000Z",
  "conversationId": "2090100861577875506",
  "isReply": false, "isRetweet": false, "isQuote": false,
  "inReplyToId": null, "quotedTweetId": null,
  "author": { "id": "3510729917", "username": "apify", "name": "Apify",
              "verified": true, "followers": 12173, "following": 296 },
  "metrics": { "likes": 1, "retweets": 0, "replies": 2, "quotes": 0,
               "bookmarks": 0, "views": null },
  "entities": { "hashtags": [], "mentions": [], "urls": [], "media": [] },
  "source": null,
  "scrapedAt": "2026-08-19T22:41:59.284Z"
}
```

---

## Architecture

```
main.ts        wiring only — the one place that knows about Apify
  ├── app/     orchestration: validate, plan, page, summarise
  ├── domain/  PURE. Filters, normalizer, quota. No IO, no clock, no platform.
  ├── x/       X's internal API: tokens, query ids, operations, decoders
  └── infra/   transport: HTTP pool, retry policy, entitlements, dataset sink
```

`domain/` imports nothing from the other layers. That is what lets the filter,
normalizer and quota tests — the modules carrying the output contract and the
free-tier requirement — run in milliseconds with no network and no mocking.

Full data-flow diagram and a module-by-module walkthrough:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## The browserless approach

### Transport

X's web client talks to an internal GraphQL gateway:

```
GET https://api.x.com/graphql/<queryId>/<OperationName>?variables=…&features=…
```

Three things gate a request:

| Gate | What it is |
|---|---|
| `authorization: Bearer …` | A **public constant** shipped in x.com's JavaScript bundle. Every anonymous browser receives the same one. It is not anybody's credential, which is why hardcoding it does not violate §3 — the per-visitor part is the guest token |
| `x-guest-token` | Minted at runtime from `POST /1.1/guest/activate.json` |
| `<queryId>` | Per operation, and **not constant** — see below |

### How I found which operations are guest-reachable

Before writing any actor code, I probed the API directly and recorded the results.
The full transcript is reproducible from `test/fixtures/`.

1. **Minted a guest token** — `POST /1.1/guest/activate.json` → `200`.
2. **Extracted the operation catalogue** — fetched `x.com/i/flow/login`, collected
   the 6 `abs.twimg.com/responsive-web/client-web/*.js` bundles it references, and
   regexed 3.1 MB of minified JavaScript for `{queryId, operationName}` pairs.
   **104 operations**, including every one I needed.
3. **Called each candidate** with the public bearer + guest token and an *empty*
   features map:

| Operation | Query id at capture | Status | Features required |
|---|---|---|---|
| `UserByScreenName` | `Gb-d6r0vxPOADdG62OEBpQ` | **200** | none |
| `UserTweets` | `SXVCYB8XHSS25nzIljNtZA` | **200** | none |
| `TweetResultByRestId` | `GZsN2Pc4knAoit6pXa4HSA` | **200** | none |
| `SearchTimeline` | `hyPfJYJ_XAtDYoslQc-Rgg` | **404, empty body** | — |

### Query ids: where they live and why they are resolved at runtime

`queryId` names a *persisted query* stored server-side, and X regenerates them on
every web deploy — roughly daily. Hardcoding them is the single most common reason
a scraper like this works today and is dead next week.

So they are resolved in this order, first hit wins:

1. a snapshot cached in the key-value store, while still fresh (6h)
2. live extraction from X's own bundles, exactly as in step 2 above
3. a pinned map captured at build time, as a last resort

A `404` from the gateway means the id went stale, so it is invalidated and
re-extracted — once per run, not once per request.

### Self-healing feature flags

`features` is a boolean map the gateway validates strictly. When it wants a new one
it answers `400 … The following features cannot be null: <names>`. That error is
self-describing, so the client parses the names, defaults them to `true` and retries
once. X's most common breaking change becomes a 200ms hiccup instead of an outage.
(Not currently exercised: all three operations answer with an empty map today.)

---

## Search: what I tried and why it is walled

`SearchTimeline` returns **HTTP 404 with a zero-length body** to a guest.

A bare 404 proves nothing on its own, so it was probed against controls:

| # | Request (same token, same headers) | Result | Rules out |
|---|---|---|---|
| 1 | `SearchTimeline` on `api.x.com` | `404`, body length **0** | — |
| 2 | `SearchTimeline` on `x.com/i/api` | `404`, body length **0** | a host or CORS artifact |
| 3 | **control:** `UserByScreenName`, same host and headers | `200`, 2723 bytes | transport, headers, bearer and guest token are all fine |
| 4 | **control:** a deliberately invalid query id | `404`, `{"message":"Query not found"}` | shows what a *routing* 404 looks like — and it is not this |
| 5 | legacy REST `1.1/search/tweets.json` | `404`, code 34 | retired for anonymous clients |

The signature is distinctive: a valid query id taken from X's own bundle, transport
proven working by control 3, and an **empty** 404 that differs from the
"Query not found" 404 of control 4. That is an authorization wall expressed as a
404 — hiding existence rather than answering "forbidden". Guest tokens carry no
search scope.

The only remaining door is a session cookie pair (`auth_token` + `ct0`), i.e. an
account. Shipping that responsibly means a pool of programmatically-created,
rotated accounts with fail-closed handling — a system, not a feature, and one that
trips bans and ToS. The brief forbids a personal session, and I am not going to
pretend a half-working search is better than a documented wall.

So the actor **rejects `searchTerms` at validation**, quoting the observation:

```
searchTerms is not supported by this build. X's SearchTimeline operation is not
reachable with a guest token (observed: HTTP 404 with an empty body, while
UserByScreenName returns 200 over the identical transport). Use fromUsers and/or
tweetIds instead.
```

---

## Free-tier protection

Free runs receive at most **10** items; entitled runs receive up to their requested
`maxResults`.

### Threat model

| Attack | Why it fails |
|---|---|
| `maxResults: 999999` | The ceiling is `min(entitlement.cap, requested)`. The input can lower it; it has no expression that raises it |
| Undocumented input fields (`"tier"`, `"cap"`, `"__proto__"`) | The input schema is `.strict()` — unknown keys are a hard validation error. And the entitlement path reads no input at all |
| Editing environment variables | No env var decides anything. They say *where to ask*. Faking them makes the call fail — and failing means free |
| Pointing the actor at your own "yes-you're-paid" server | The grant is Ed25519-signed. A response that does not verify against the public key compiled into the build is discarded |
| Replaying a paid user's signed grant | The grant is bound to `runId`, `actorId` and `userId`, and expires in 60 seconds |
| Reading the public source to find the check | There is no client-side decision to find. The client asks; the server decides. The source being public is part of the design |
| Blocking the network so the check errors | **Fail-closed.** Thirteen distinct failure modes are tested, and a test asserts that *none* of them can produce the paid tier |

### The mechanism

```
actor  ──POST /v1/check────►  worker
        {userId, runId,          │ 1. HMAC + freshness            (noise filter, not security)
         actorId, nonce, ts}     │ 2. GET /v2/actor-runs/<runId>  ← with OUR Apify token
        + x-signature            │    assert run.userId === claimed userId
                                 │    assert run.actId  === PUBLISHED_ACTOR_ID
                                 │    assert run.status === RUNNING
                                 │ 3. look up userId in our allow-list
        ◄──{payload, signature}──┤ 4. sign a grant bound to runId, exp = now + 60s
                                 │
     verify signature, runId, actorId, userId, expiry
     anything unexpected → free, cap 10
```

**Step 2 is the whole design.** The identity the actor sends is a *claim*; the
service re-derives it from the Apify API using its own token. A runner can put
anything in the request body, but cannot make Apify report a run of *our* actor
under a user that is not theirs.

### Enforcement point

The cap is applied where results are emitted, not by clamping `maxResults` up
front:

```ts
async offer(item: DatasetItem): Promise<boolean> {
    if (this.exhausted()) return false;
    await this.#sink.push(item);      // the only path to the dataset
    this.#pushed += 1;
    return true;
}
```

and the pager consults it *before* fetching:

```ts
while (!guard.exhausted() && pages < MAX_PAGES) { … }
```

so a capped run stops requesting data it could never emit — a free run issues one
upstream request and stops. Two structural supports:

- `#pushed` uses a real JavaScript private field, not TypeScript's `private`, which
  is only an annotation and vanishes at compile time.
- An eslint rule fails the build if `Actor.pushData` appears outside the two files
  allowed to hold it. The invariant is machine-checked, not aspirational.

Resumed runs restore `pushed` from persisted state. Without that, a free user could
abort and resume repeatedly and collect ten items each time.

### Transparency

```
WARN  Free tier: results capped at 10 (requested 1000). Upgrade for higher limits.
```

and `RUN_SUMMARY` in the key-value store carries
`{ limited: true, reason: "free_tier", cap: 10, requested, pushed, … }`.

### Anti-fork reasoning

Three moves, including the limit of what is achievable:

1. **A fork is not a bypass of the deployed product.** Users of the published actor
   run the published image. They control input, environment variables and run
   options; they do not control the build. Nothing they control moves the cap.

2. **Forking is a different act with a different cost.** Someone who clones the
   repo, strips `QuotaGuard` and deploys their own actor pays their own compute and
   proxy, takes on maintaining the query-id registry as X rotates it, and forfeits
   updates. What they have not done is get free results out of *our* actor. That is
   competition, answered by licence, trademark and product velocity — not by code.

3. **Defeating the fork outright requires moving the resource server-side.** The
   only technically sound version: make the path beyond item 10 *require* something
   only our server can supply — serving the query-id registry per entitled run, or
   relaying results through infrastructure we control. That is a product decision
   with real cost, not a take-home decision, but naming it matters:
   **you cannot protect a secret that runs on the attacker's machine; you can only
   move the thing of value off it.**

This build implements (1) and (2) fully, and keeps every capability behind one
injectable port so (3) stays a configuration change rather than a rewrite.

---

## Resilience and scale

- **Pagination** by Bottom cursor, with three termination guards: no cursor, a
  repeated cursor, or a page yielding nothing new. X returns a *stable cursor with
  an empty page* at the end of a timeline, and a naive `while (cursor)` spins on it
  forever.
- **Deduplication** by a global seen-set spanning all targets, so overlapping
  sources cannot emit the same tweet twice.
- **Guest tokens** are keyed by session, single-flighted (ten concurrent 403s mint
  one token, not ten), budgeted, and snapshotted for migrations.
- **Sessions** pair a proxy IP with the token minted through it and reuse both
  across that target's pages. A token minted through one IP and replayed through
  another is a visitor teleporting between networks — one of the cheapest bot
  signals there is. The same decision keeps connections warm.
- **Backoff** is exponential with jitter in [50%, 100%] of the ceiling. Without
  jitter, every worker that got a 429 at the same instant retries at the same
  instant and the synchronised stampede keeps the server exactly as overloaded.
  `x-rate-limit-reset` is honoured when X sends it.
- **A dropped keep-alive socket** (`ECONNRESET` with no status) is retried
  immediately without backoff: the pool handed out a connection the server had
  already closed, and waiting fixes nothing.
- **Retry budget** is run-wide (`50 + 5 per target`), so one broken target cannot
  spend the whole time budget.
- **State** is persisted on `migrating` and every 10s: cursors, the seen-set, and
  `pushed`. A resurrected run resumes rather than restarts.
- **Graceful degradation:** protected, suspended, not-found and deleted targets are
  recorded with a reason and skipped. The run succeeds; the summary explains.

---

## Performance

**Measured, no proxy, 2026-08-19:** 116 tweets across 6 pages in **2776 ms**,
10 requests total including the token mint, bundle fetches and profile lookup.

**Not yet measured on residential proxy.** The estimate is 5–6s for 100 items
(≈600ms RTT vs ≈80ms direct, 6 sequential pages), which is comfortably inside the
30-second band — but it is an estimate, and it is labelled as one. I would rather
report a measured number with its conditions than an unlabelled one.

An important finding: **X does not honour `count`.** Measured across 20/40/100/200,
`UserTweets` returns 20 entries every time, so the page-size lever does not exist.
The margin comes from keep-alive, from resolving query ids and the guest token
concurrently, and from cross-target parallelism. Pages *within* one author are
strictly serial, because each needs the previous page's cursor.

---

## Testing

```bash
npm run check     # typecheck + lint + tests
```

170 tests, no network: every upstream response is a fixture captured from the live
API and committed under `test/fixtures/`. Worth calling out:

- **`quota.test.ts`** — the test the brief requires: a free user with
  `maxResults: 1000` receives exactly 10. Plus a pager test proving the cap stops
  *fetching*, not just pushing, and a resume test proving the budget is not reset.
- **`entitlements.test.ts`** — thirteen failure modes, each asserting free/10, and
  one test asserting that no failure path can produce the paid tier.
- **`no-browser.test.ts`** — §3 is an automatic fail, so it is machine-checked.
- **`decode-*.test.ts`** — run against real captured payloads, including a video
  tweet whose four variants are ordered so that picking the first or the last mp4
  gives the wrong answer.

---

## Known limitations

- **No free-text search.** Documented above at length.
- **`sortBy: "top"`** is accepted but only `latest` is meaningful for author
  timelines, which are chronological. No ranked surface is implemented.
- **`source` is usually `null`** on guest responses — X often omits it.
- **`views` is usually `null`** — absent on every tweet sampled.
- **Timeline depth** is bounded by what X serves anonymously (~3,200 tweets).
- **The residential benchmark is an estimate**, not a measurement.
- **Query ids and payload shapes are undocumented and change without notice.** The
  runtime registry and the fixtures mitigate this; they do not eliminate it.

---

## ToS and robots considerations

Only public data is collected, with no login and no circumvention of an access
control tied to an account. Before running this for a client I would raise:

- **X's Terms of Service restrict automated access** regardless of the data being
  public. Where volume justifies it, the paid X API is the defensible route, and
  this actor is the cheaper option, not the safer one.
- **`x.com/robots.txt`** disallows most paths for generic crawlers. The internal
  API is not covered by robots directives, which is a gap in the directive, not a
  permission.
- **Tweets contain personal data even when public.** Under GDPR that means a
  documented lawful basis, a retention policy and a deletion path — obligations
  that grow sharply if results are stored rather than passed through.
- **Rate limiting conservatively** is both an ethical and an operational choice.
  Concurrency defaults are deliberately modest and are not exposed as input, since
  a user cranking them is how an IP pool gets burned.
- **Never collect from protected accounts.** Protected targets are detected and
  skipped with a reason.

---

## Decisions and trade-offs

- **Probed before coding.** Three assumptions I had written from memory did not
  survive contact with the API: the User object no longer has `legacy`, the
  timeline path is not `timeline_v2`, and `UserTweets` returns no profile fields.
  Finding that at hour zero rather than hour five is the entire argument for
  spending the first 45 minutes on `curl`.
- **Rejected search rather than half-shipping it.** The brief says honest scoping
  counts in your favour; I took that literally, and documented the controls that
  make the diagnosis conclusive rather than asserting a wall.
- **Query ids at runtime, not constants.** The most likely way this rots is the one
  thing designed against.
- **The gate is structural, not careful.** One write path, machine-checked; a real
  private field; the ceiling from a server; fail-closed everywhere. A gate that
  depends on someone remembering an invariant is not a gate.
- **`domain/` is pure.** It costs an extra type and a mapper, and buys a test suite
  that runs offline in milliseconds over exactly the code that carries the contract.
- **Named the limit of the anti-fork argument** instead of overclaiming. A fork can
  strip the check; what it cannot do is get free results from the published actor.
- **With another two days:** measure on residential properly, implement the
  syndication CDN fallback for when the guest door narrows, add the cross-target
  concurrency the design already allows, and stand up the incremental-scrape path
  that the persisted `lastSeenId` already makes cheap.
