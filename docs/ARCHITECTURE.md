# Architecture

How the actor is put together, and why each boundary is where it is.

## 1. The layering rule

```
main.ts          wiring only — the single place that knows about Apify
   │
   ├── app/      orchestration: validate, plan, page, summarise
   │
   ├── domain/   PURE. Filters, normalizer, quota. No IO, no clock, no platform.
   │
   ├── x/        X's internal API: tokens, query ids, operations, decoders
   │
   └── infra/    transport: HTTP pool, retry policy, entitlements, dataset sink
```

Dependencies point downward, with one hard rule: **`domain/` imports nothing from
`x/`, `infra/` or `apify`.** That is what makes the filter, normalizer and quota
tests run in milliseconds with no network, no fixtures and no mocking framework —
and those three modules are where the assessment's contract and its 25% free-tier
requirement actually live.

`x/` and `infra/` may import `domain/` (they produce and consume its types).
Nothing imports `app/` except `main.ts`.

## 2. Data flow

```
INPUT (json)
  │
  │  parseInput()                       ── zod, .strict()
  ▼                                        unknown field  → InputValidationError, exit 1
ActorInput ──► toFilters() ──► Filters     searchTerms    → rejected with the observed reason
  │
  ├──► resolveEntitlement() ──HTTPS──► entitlements service ──► { tier, cap }
  │                                     any failure ────────► free / cap 10
  │                                                             │
  │                                                             ▼
  │                                                     QuotaGuard(cap)
  │                                            the only holder of the dataset sink
  ▼
targets
  ├─ tweetIds[]  ─► TweetResultByRestId ─┐
  └─ fromUsers[] ─► UserByScreenName     │   (resolves the numeric user id)
                    └─► UserTweets ──────┤   cursor loop, 20 entries per page
                                         │
                                         ▼
                              raw GraphQL payload
                                         │  decode (zod)  ── failure degrades ONE item
                                         ▼
                                   TweetEntity
                                         │  applyFilters()  ── pure; reports rejectedBy
                                         ▼  kept
                                   normalize()  ── the §5 contract, exactly
                                         ▼
                              guard.offer(item)
                                  ├─ accepted → Actor.pushData
                                  └─ refused  → guard.exhausted() stops the pager
                                         ▼
                                    RunSummary → log + KV
```

## 3. Modules

### `domain/` — pure

| Module | Responsibility | Why it is here |
|---|---|---|
| `types.ts` | `DatasetItem` (the §5 contract), `TweetEntity`, `Filters`, `Entitlement`, and the `Clock` / `ResultSink` ports | One place that states what the product promises |
| `normalize.ts` | `TweetEntity → DatasetItem` | The contract belongs to the client; the entity belongs to us. The mapper is where "does this field become public?" is a decision someone writes by hand, not a side effect of a spread |
| `filters.ts` | The §4 filter pipeline, as an ordered list of `{ reason, test }` rules | Reports *which* constraint rejected a tweet, which feeds the summary and makes the tests readable. Also exports `isBeforeWindow`, which is flow control rather than filtering — see §5 |
| `quota.ts` | `QuotaGuard`: the free-tier enforcement point | See §4 |

### `x/` — X's internal API

| Module | Responsibility | Notes |
|---|---|---|
| `client.ts` | Header assembly, the retry loop, token rotation, feature-map healing, query-id invalidation | Holds the public web bearer — a constant from x.com's bundle, not anybody's credential |
| `guestToken.ts` | Mint / cache / rotate, single-flight, mint budget, snapshot for migrations | Keyed by *session*, because a token belongs to the IP that minted it |
| `queryIds.ts` | Resolves per-operation ids at runtime from X's own bundles; KV cache → live extraction → pinned map | X regenerates these on every web deploy. Hardcoding them is why scrapers rot |
| `queryIds.pinned.ts` | The fallback map, with its capture date | Explicitly a fallback, never the source of truth |
| `ops.ts` | The three guest-reachable operations | `SearchTimeline` is absent on purpose |
| `decode/user.ts` | User payload → `AuthorEntity` | X moved the User object off `legacy`; see §6 |
| `decode/tweet.ts` | Tweet payload → `TweetEntity` | Retweet unwrapping, media variants, link expansion |
| `decode/timeline.ts` | Instruction soup → page of tweets + cursor | Handles conversation modules and the pinned entry |

### `infra/` — transport

| Module | Responsibility | Notes |
|---|---|---|
| `http.ts` | undici with one connection pool per proxy session | Keep-alive: a warm connection skips the TCP + TLS handshakes, which over residential proxy is most of a request's cost |
| `retry.ts` | Failure classification, exponential backoff with jitter, retry budget | Pure and injectable — the randomness is a parameter, so the policy is asserted rather than observed |
| `entitlements.ts` | Asks the service, verifies the signed grant, fails closed | See §4 |
| `dataset.ts` | The one `Actor.pushData` call in the codebase | A dumb pipe with no policy of its own |

### `app/` — orchestration

| Module | Responsibility |
|---|---|
| `input.ts` | Zod validation at the boundary, plus the projection to `Filters` |
| `run.ts` | Target planning, the cursor loop, per-target degradation |
| `state.ts` | Resumable state, and the global dedupe set |
| `summary.ts` | Accumulates the run report |

## 4. The free-tier gate, structurally

Two properties make it a gate rather than a suggestion, and both are structural
rather than a matter of care:

**One write path.** `QuotaGuard` is the only holder of the `ResultSink`, and
`infra/dataset.ts` is the only module that calls `Actor.pushData`. An eslint rule
fails the build if `pushData` appears anywhere else, so the invariant is
machine-checked rather than aspirational. There is exactly one surface to audit.

**Enforced at emission, not by clamping.** The pager calls `guard.remaining()`
*before* requesting the next page, so a capped run stops fetching rather than
fetching and discarding. A free run issues one upstream request and stops — the cap
saves proxy cost as well as enforcing the limit.

The cap itself is `min(entitlement.cap, input.maxResults)`. The input can lower the
ceiling; it has no expression that raises it.

## 5. Two things that look like filters and are not

**`isBeforeWindow`** is flow control. Author timelines are newest-first, so the
first tweet older than `since` means every remaining page is older too. The pager
stops instead of walking years of history to discard it one item at a time.

**The global dedupe set** lives in `app/state.ts`, not in the filters, because it
spans targets: if you scrape two accounts and one retweeted the other, a per-page
check would still emit the tweet twice.

## 6. Decoders are written against captured payloads

The decoders match what X returns today, not the field names one would expect from
its older public API. Three differences matter enough to state:

| Commonly assumed | What X actually returns |
|---|---|
| `user.legacy.screen_name`, `followers_count` | The User object has **no `legacy`**: `core.screen_name`, `relationship_counts.followers`, `verification.*` |
| `timeline_v2.timeline.instructions` | `timeline.timeline.instructions` |
| `UserTweets` includes the profile | It returns only `{ __typename, timeline }` — the profile comes from the `UserByScreenName` call that resolved the id |

Responses captured from the live API are committed under `test/fixtures/`, and the
decoder tests run against them, so a change in X's shape shows up as a failing test
rather than as empty output.

Two behaviours discovered by measurement rather than by reading:

- **`count` is ignored.** Requested at 20, 40, 100 and 200, the response is the same.
- **Pagination is account-dependent.** A busy author returns ~99 entries and *no
  cursor*; a quieter one returns ~20 with a cursor. The pager handles both, and the
  ceiling is documented in the README rather than hidden.

## 7. Error taxonomy

| Class | Examples | Behaviour |
|---|---|---|
| `retryable` | 429, 5xx, socket errors | Backoff with jitter, bounded by a run-wide budget |
| `auth` | 401, 403 *with* "Bad guest token" | Rotate the guest token once, then give up on the target |
| `schema` | 404 (stale query id), 400 naming missing features | Invalidate and re-extract, or heal the feature map from X's own error text, and retry once |
| `fatal` | 400, plain 403, 4xx | No retry: repeating it is noise |

A plain 403 and a 403 carrying "Bad guest token" are deliberately different
classes: the first is a wall, the second is an expired credential.

Decode failures degrade a single item and increment a counter. One malformed tweet
must never end a run that has been going for twenty minutes.
