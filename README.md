# x-tweet-scraper

Browserless X (Twitter) scraper for Apify. HTTP only against X's internal GraphQL,
guest-token auth, a strict output contract, and a free-tier gate whose source of
truth is a server the runner does not control.

- **Repo:** https://github.com/ramyx/x-tweet-scraper
- **Actor:** `bEAaMlZm4LDT5RQuh` on Apify — [Setup](#setup) deploys it from a fresh clone
- **Tests:** 170, all offline against captured fixtures

---

## What this build does, and does not

| Surface | Operation | Status |
|---|---|---|
| Tweets by author | `UserTweets` | ✅ implemented |
| A single tweet by id | `TweetResultByRestId` | ✅ implemented |
| A user profile by handle | `UserByScreenName` | ✅ implemented |
| Free-text search | `SearchTimeline` | ❌ **not reachable with a guest token** |
| Replies timeline | `UserTweetsAndReplies` | ❌ **not reachable either** — `includeReplies` degrades, see below |

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

Deploying your own copy — actor and entitlements service — is in
[Setup](#setup) at the end of this file.

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

## Examples

All output below is verbatim from runs of the deployed actor.

### Tweets by author

Input:

```json
{ "fromUsers": ["apify"], "maxResults": 100,
  "proxyConfiguration": { "useApifyProxy": true } }
```

One dataset item, with video attached:

```json
{
  "id": "2090465188768096585",
  "url": "https://x.com/apify/status/2090465188768096585",
  "text": "Sessions are gone 🚨 New MCP spec 2026-07-28 goes fully stateless, and Apify has supported it since the week it shipped.\n\nThree weeks in, 1 client in 8 takes the stateless path, up from 1% a week ago.\n\nWatch @michaeldaigler_ walk through the major core protocol updates.",
  "lang": "en",
  "createdAt": "2026-08-20T15:45:14.000Z",
  "conversationId": "2090465188768096585",
  "isReply": false,
  "isRetweet": false,
  "isQuote": false,
  "inReplyToId": null,
  "quotedTweetId": null,
  "author": {
    "id": "3510729917",
    "username": "apify",
    "name": "Apify",
    "verified": true,
    "followers": 12276,
    "following": 296
  },
  "metrics": {
    "likes": 0,
    "retweets": 0,
    "replies": 1,
    "quotes": 0,
    "bookmarks": 0,
    "views": null
  },
  "entities": {
    "hashtags": [],
    "mentions": [
      "michaeldaigler_"
    ],
    "urls": [],
    "media": [
      {
        "type": "video",
        "url": "https://video.twimg.com/amplify_video/2090464741877555200/vid/avc1/1920x1244/atjJR5ed1epTKJfW.mp4?tag=29",
        "thumbnail": "https://pbs.twimg.com/amplify_video_thumb/2090464741877555200/img/c8OwOlx3_C7fk8GM.jpg"
      }
    ]
  },
  "source": "Twitter Web App",
  "scrapedAt": "2026-08-20T16:09:00.035Z"
}
```

Note `views: null` — X does not expose the counter on this surface, and the schema
requires the key to be present rather than omitted. The video `url` is the
highest-bitrate mp4 of the four variants X offers; `thumbnail` is the poster frame.

### A single tweet by id

Input:

```json
{ "tweetIds": ["20"] }
```

```json
{
  "id": "20",
  "url": "https://x.com/jack/status/20",
  "text": "just setting up my twttr",
  "lang": "en",
  "createdAt": "2006-03-21T20:50:14.000Z",
  "author": { "id": "12", "username": "jack", "name": "jack",
              "verified": true, "followers": 11460767, "following": 3 },
  "...": "remaining keys as in the schema"
}
```

### Filters

```json
{ "fromUsers": ["apify"], "minLikes": 25, "language": "en",
  "mediaType": "video", "includeRetweets": false, "maxResults": 50 }
```

The run summary reports what each filter removed, so an empty result set explains
itself instead of looking like a failure:

```json
"filteredOut": { "includeReplies": 67, "includeRetweets": 50 }
```

### Search is rejected, not silently empty

```json
{ "searchTerms": ["apify"] }
```

```
Invalid input:
  - searchTerms: searchTerms is not supported by this build. X's SearchTimeline
    operation is not reachable with a guest token (observed: HTTP 404 with an empty
    body, while UserByScreenName returns 200 over the identical transport).
    Use fromUsers and/or tweetIds instead.
```

### The free-tier cap, demonstrated

Same build, same account, same input. The only difference is one record in a
key-value store on a server the runner does not control.

**Before granting entitlement** — `maxResults: 1000`:

```json
{
  "requested": 1000,
  "fetched": 21,
  "pushed": 10,
  "limited": true,
  "reason": "free_tier",
  "cap": 10,
  "entitlement": {
    "tier": "free",
    "source": "service"
  },
  "requests": 2,
  "durationMs": 2727
}
```

Ten items. Note `requests: 2`: the cap stopped the pager from asking X for a second
page, rather than fetching data and discarding it.

**After granting entitlement** — same actor, `maxResults: 100`:

```json
{
  "requested": 100,
  "fetched": 228,
  "pushed": 100,
  "limited": false,
  "reason": null,
  "cap": 100,
  "entitlement": {
    "tier": "paid",
    "source": "service"
  },
  "requests": 13,
  "retries": 0,
  "guestTokensMinted": 1,
  "durationMs": 27352
}
```

`entitlement.source` is `"service"` in both, not `"fail-closed"`: the worker was
reached, it verified the run against the Apify API, and the actor verified its
signature. The cap moved because the server changed its answer.

## For the reviewer

Everything below can be checked without any coordination with me.

### Just look at the output

Two runs of the deployed actor, same build and same account, differing only in
whether the entitlements service had granted the user:

| Run | Input | Result |
|---|---|---|
| `PeqTgdwFQyR1bkE7Y` | `maxResults: 1000`, not entitled | 10 items, `limited: true`, `reason: free_tier` |
| `zwYXrq0UZ6T001IeD` | `maxResults: 100`, entitled | 100 items, `limited: false` |
| `7h7fLS2ApJrovWdma` | `elonmusk`, residential | 99 items in 7.1 s |

Their summaries are reproduced verbatim under [Examples](#examples).

### Run it yourself

[Setup](#setup) deploys the whole thing — actor and entitlements service — from a
fresh clone, with every command spelled out. It needs an Apify account and a
Cloudflare one, both on their free tiers, and takes a few minutes.

### Verify the free-tier gate yourself

Run it once as-is: you are not on the allow-list, so you get 10 items whatever
`maxResults` says. Then entitle yourself with the admin secret included in my
submission email:

```bash
curl -X POST https://x-tweet-scraper-entitlements.ramiro-daniel-ing.workers.dev/v1/admin/grant \
  -H "authorization: Bearer <ADMIN_SECRET from the email>" \
  -H 'content-type: application/json' \
  -d '{"userId":"<your Apify user id>","tier":"paid"}'
```

and run the identical input again. Nothing on your side changed; the ceiling did.

Handing you that secret is deliberate. The gate's security is that the *decision*
lives on a server the runner does not control — not that the reviewer is kept away
from it. You can also confirm the negative case: grant a different user id and your
own run is still capped, because the grant is bound to the run it was issued for.

## Architecture

```
main.ts        wiring only — the one place that knows about Apify
  ├── app/     orchestration: validate, plan, page, summarise
  ├── domain/  PURE. Filters, normalizer, quota. No IO, no clock, no platform.
  ├── x/       X's internal API: tokens, query ids, operations, decoders
  └── infra/   transport: HTTP pool, retry policy, entitlements, dataset sink
```

Dependencies point downward, with one hard rule: **`domain/` imports nothing from
`x/`, `infra/` or `apify`.** That is what lets the filter, normalizer and quota
tests — the modules carrying the output contract and the free-tier requirement —
run in milliseconds with no network and no mocking.

### Data flow

```
INPUT (json)
  │  parseInput()   ── zod, .strict()   unknown field → validation error, exit 1
  ▼                                     searchTerms   → rejected with the reason
ActorInput ──► Filters
  │
  ├──► resolveEntitlement() ──HTTPS──► entitlements service ──► { tier, cap }
  │                                    any failure ─────────► free / cap 10
  │                                                             ▼
  │                                                     QuotaGuard(cap)
  │                                          the only holder of the dataset sink
  ▼
targets
  ├─ tweetIds[]  ─► TweetResultByRestId
  └─ fromUsers[] ─► UserByScreenName ─► UserTweets (cursor loop)
                                         │
                       raw payload ──────┤ decode (zod) — failure degrades ONE item
                                         ▼
                                   TweetEntity
                                         │ applyFilters()  pure; reports rejectedBy
                                         ▼ kept
                                   normalize()  the §5 contract, exactly
                                         ▼
                                guard.offer(item)
                                   ├─ accepted → Actor.pushData
                                   └─ refused  → exhausted() stops the pager
                                         ▼
                                   RunSummary → log + KV
```

### Modules

| Module | Responsibility |
|---|---|
| `domain/types.ts` | The §5 contract, `TweetEntity`, `Filters`, `Entitlement`, and the `Clock` / `ResultSink` ports |
| `domain/normalize.ts` | `TweetEntity → DatasetItem`. Fields are listed one by one, not spread, so "does this become public?" is a decision written by hand |
| `domain/filters.ts` | The §4 pipeline as an ordered list of `{ reason, test }` rules, reporting *which* constraint rejected a tweet |
| `domain/quota.ts` | `QuotaGuard` — the free-tier enforcement point |
| `x/client.ts` | Header assembly, retry loop, token rotation, feature healing, query-id invalidation |
| `x/guestToken.ts` | Mint / cache / rotate, single-flight, mint budget, snapshot for migrations |
| `x/queryIds.ts` | Runtime resolution from X's bundles: KV cache → live extraction → pinned map |
| `x/ops.ts` | The guest-reachable operations, and the replies fallback |
| `x/decode/*.ts` | User, tweet and timeline payloads → domain entities |
| `infra/http.ts` | undici, one connection pool per proxy session |
| `infra/retry.ts` | Failure classification, backoff with jitter, retry budget |
| `infra/entitlements.ts` | Asks the service, verifies the signed grant, fails closed |
| `infra/dataset.ts` | The one `Actor.pushData` call in the codebase |
| `app/input.ts` | Zod validation at the boundary, projection to `Filters` |
| `app/run.ts` | Target planning, cursor loop, per-target degradation |
| `app/state.ts` | Resumable state and the global dedupe set |
| `app/summary.ts` | Accumulates the run report |

### Decoders are written against captured payloads

They match what X returns today, not what its older public API suggests:

| Commonly assumed | What X actually returns |
|---|---|
| `user.legacy.screen_name`, `followers_count` | The User object has **no `legacy`**: `core.screen_name`, `relationship_counts.followers`, `verification.*` |
| `timeline_v2.timeline.instructions` | `timeline.timeline.instructions` |
| `UserTweets` includes the profile | Only `{ __typename, timeline }` — the profile comes from `UserByScreenName` |

Live responses are committed under `test/fixtures/`, so a change in X's shape shows
up as a failing test rather than as empty output.

### Two things that look like filters and are not

**`isBeforeWindow`** is flow control: timelines are newest-first, so the first tweet
older than `since` means every remaining page is older too, and the pager stops.

**The global dedupe set** spans targets, because scraping two accounts where one
retweeted the other would otherwise emit the tweet twice.

### Error taxonomy

| Class | Examples | Behaviour |
|---|---|---|
| `retryable` | 429, 5xx, socket errors | Backoff with jitter, bounded by a run-wide budget |
| `auth` | 401, 403 *with* "Bad guest token" | Rotate the guest token once, then give up on the target |
| `schema` | 404 (stale query id), 400 naming missing features | Invalidate and re-extract, or heal the feature map from X's own error text |
| `fatal` | 400, plain 403, other 4xx | No retry: repeating it is noise |

A plain 403 and a 403 carrying "Bad guest token" are deliberately different classes:
the first is a wall, the second an expired credential. Decode failures degrade a
single item and increment a counter — one malformed tweet must never end a run.

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
once, so X's most common breaking change becomes a 200 ms hiccup instead of an
outage. The operations used today need no flags at all; this is insurance.

---

## Search: what I tried and why it is walled

`SearchTimeline` returns **HTTP 404 with a zero-length body** to a guest, using the
query id read from X's own bundle.

| # | Request (same token, same headers) | Result |
|---|---|---|
| 1 | `SearchTimeline` on `api.x.com` | `404`, body length **0** |
| 2 | `SearchTimeline` on `x.com/i/api` | `404`, body length **0** |
| 3 | **control:** `UserByScreenName`, same host and headers | **`200`**, 2723 bytes |
| 4 | **control:** `UserTweets`, same host and headers | **`200`**, 516 KB |
| 5 | legacy REST `1.1/search/tweets.json` | `404`, code 34 "that page does not exist" |

Controls 3 and 4 are what make this conclusive: the transport, the bearer, the guest
token and the header set are all demonstrably fine, because two other operations
answer `200` over exactly the same request. Search does not.

**What I cannot tell you** is whether X means "forbidden" or "no such route": a
deliberately invalid query id also returns an empty 404, so the response body does
not distinguish an authorization wall from a missing one. I probed for that
distinction and it is not reliably observable from outside. What is observable, and
sufficient, is that the operation is not reachable with a guest token while others
are.

The remaining door is a session cookie pair (`auth_token` + `ct0`), i.e. an account.
Shipping that responsibly means a pool of programmatically-created, rotated accounts
with fail-closed handling — a system, not a feature, and one that trips bans and
ToS. The brief forbids a personal session, and a half-working search that gets the
client banned is worse than a documented wall.

So the actor **rejects `searchTerms` at validation**, quoting the observation:

```
searchTerms is not supported by this build. X's SearchTimeline operation is not
reachable with a guest token (observed: HTTP 404 with an empty body, while
UserByScreenName returns 200 over the identical transport). Use fromUsers and/or
tweetIds instead.
```

### `UserTweetsAndReplies` is walled the same way

Verified 2026-08-20: **404 with an empty body**, with the query id taken from the
bundle that same minute, while `UserTweets` returned `200` for the same user over
the same connection. So `includeReplies: true` cannot use the replies timeline.

Rather than failing the target, the actor **degrades to the main timeline** and says
so, in the log and in the run summary (`errors.replies_timeline_unavailable`).
Replies that appear on the author's main timeline are still returned; standalone
replies are not.

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

**Measured on the deployed actor, residential proxy, entitled run, 2026-08-20:**

| Target | Items | Wall clock | Requests | Retries |
|---|---|---|---|---|
| `elonmusk`, `maxResults: 100` | **99** | **7.1 s** | 2 | 0 |
| `apify`, `maxResults: 100` | 100 | 27.4 s | 13 | 0 |

Run ids: `7h7fLS2ApJrovWdma` (residential) and `zwYXrq0UZ6T001IeD` (default proxy).
No bans, no 429s, no duplicate ids in either.

### Why one number is 7 s and the other 27 s

X's guest timeline behaves differently per account, and this is the single most
important operational finding in the project:

| | `elonmusk` | `apify` |
|---|---|---|
| Entries in page 1 | **99** | 17 |
| Bottom cursor | **absent** | present |
| Pages available to a guest | **1** | many |

A busy author comes back with ~99 tweets in **one request** and no cursor at all —
X hands an anonymous visitor a single batch and stops. A quieter account returns
~20 entries per page *with* a cursor, and pages normally.

So for the §8 benchmark shape — one high-volume author, 100 results — the honest
statement is: **99 results in 7.1 seconds, and the hundredth is not reachable from
that surface**, because X does not offer a cursor to continue. Reaching exactly 100
requires a second target. I would rather report that than quietly return 99 and let
the number look like a rounding error.

`count` is ignored entirely: measured at 20, 40, 100 and 200, the response is
byte-for-byte the same shape. Page size is not a lever.

Where the remaining time goes on the multi-page case: residential RTT dominates at
roughly 600 ms per request, and pages within one author are strictly serial because
each needs the previous page's cursor. The levers that do exist are keep-alive
(one TLS handshake per session instead of one per request), resolving query ids and
the guest token concurrently, and parallelism across targets.

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
- **Timeline depth for a guest is account-dependent and can be a single page.**
  High-volume authors return ~99 tweets with no cursor, so that is the ceiling for
  one target. See [Performance](#performance).
- **`includeReplies` is best-effort**, because the replies timeline is not reachable
  with a guest token. It degrades to the main timeline and reports it.
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

## Tooling

I used Claude Code as a development aid throughout, supervised step by step. The API
investigation, the architecture decisions and the scoping calls are mine, and I can
talk through any part of the codebase.

---

## Decisions and trade-offs

- **Probed the API before writing the decoders**, and wrote them against captured
  payloads rather than against the field names one expects. X's User object has
  moved off `legacy`, and a decoder written from memory decodes to nothing today.
- **Rejected search rather than half-shipping it.** The controls in
  [Search](#search-what-i-tried-and-why-it-is-walled) are the evidence, and the
  limits of that evidence are stated alongside it.
- **Query ids at runtime, not constants.** The most likely way this rots is the one
  thing designed against.
- **The gate is structural, not careful.** One write path, machine-checked; a real
  private field; the ceiling from a server; fail-closed everywhere. A gate that
  depends on someone remembering an invariant is not a gate.
- **`domain/` is pure.** It costs an extra type and a mapper, and buys a test suite
  that runs offline in milliseconds over exactly the code that carries the contract.
- **Named the limit of the anti-fork argument** instead of overclaiming. A fork can
  strip the check; what it cannot do is get free results from the published actor.
- **With another two days:** a syndication-CDN fallback for when the guest door
  narrows further, the cross-target concurrency the design already allows, and the
  incremental-scrape path that the persisted cursors already make cheap.

---

## Setup

Local development needs no accounts. Deploying needs an Apify account and a
Cloudflare one.

### Run locally

```bash
git clone https://github.com/ramyx/x-tweet-scraper.git
cd x-tweet-scraper && npm ci && npm run check
npm run build
mkdir -p storage/key_value_stores/default
echo '{ "fromUsers": ["apify"], "maxResults": 5,
        "proxyConfiguration": { "useApifyProxy": false } }' \
  > storage/key_value_stores/default/INPUT.json
node dist/main.js
```

Results land in `storage/datasets/default/`. A local run has no platform identity to
verify, so entitlement resolves to free with reason `local_run` — the fail-closed
path working as designed.

### Deploy the actor

```bash
npm install -g apify-cli && apify login
apify push                      # note the actor id it prints
```

### Deploy the entitlements service

```bash
npm install -g wrangler && wrangler login
cd entitlements
cp wrangler.example.toml wrangler.toml
wrangler kv namespace create ENTITLEMENTS      # paste the id into wrangler.toml
```

Set `PUBLISHED_ACTOR_ID` in `wrangler.toml` to your actor id — that value is the
anti-fork pin, since grants are only issued for runs of that actor.

Generate the signing keypair. The worker signs; the actor only ever verifies, so it
never holds the private half:

```bash
node -e '
const { generateKeyPairSync } = require("node:crypto");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
console.log("PRIVATE (worker):", privateKey.export({format:"pkcs8",type:"pkcs8"}).toString("base64"));
console.log("PUBLIC  (actor) :", publicKey.export({format:"der",type:"spki"}).toString("base64"));
'
```

```bash
wrangler secret put APIFY_SERVICE_TOKEN   # YOUR Apify API token, never a runner's
wrangler secret put ACTOR_SHARED_SECRET   # random 32+ chars; also goes in the actor
wrangler secret put ED25519_PRIVATE_KEY
wrangler secret put ADMIN_SECRET          # random 32+ chars, for granting entitlements
wrangler deploy
curl https://<your-worker>.workers.dev/v1/health     # {"ok":true}
```

`APIFY_SERVICE_TOKEN` is what makes the check authoritative: the worker asks the
Apify API itself who owns the run, rather than believing the caller.

### Wire them together

Actor → Settings → Environment variables, all marked **secret**, then rebuild:

| Variable | Value |
|---|---|
| `ENTITLEMENTS_URL` | `https://<your-worker>.workers.dev/v1/check` |
| `ENTITLEMENTS_SHARED_SECRET` | the same `ACTOR_SHARED_SECRET` |
| `ENTITLEMENTS_PUBLIC_KEY` | the public key above |

These only say *where to ask*. Faking them makes the call fail, and failing means
free.

### Granting entitlement

```bash
curl -X POST https://<your-worker>.workers.dev/v1/admin/grant \
  -H "authorization: Bearer $ADMIN_SECRET" -H 'content-type: application/json' \
  -d '{"userId":"<apify user id>","tier":"paid"}'
```

### Troubleshooting

| Log line | Cause |
|---|---|
| `reason: "local_run"` | Running locally. Expected. |
| `reason: "not_configured"` | The three actor env vars are missing. |
| `reason: "service_unreachable"` | Wrong URL or the worker is down. Fail-closed is working. |
| `reason: "bad_signature"` | `ENTITLEMENTS_PUBLIC_KEY` does not match the worker's private key. |
| `reason: "actor_mismatch"` | `PUBLISHED_ACTOR_ID` is not this actor. |
| Worker `403 unknown run` | `APIFY_SERVICE_TOKEN` cannot read the run. |
