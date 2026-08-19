# Entitlements service

The authority behind the actor's free-tier gate. The actor asks; this decides.

## Why a separate service

A check that lives only in code the runner can edit is not a check. This service is
the thing the actor cannot lie to, for one reason: **it re-derives the caller's
identity from the Apify API using its own token.**

```
actor  ──POST /v1/check────►  worker
        {userId, runId,          │
         actorId, nonce, ts}     │ 1. HMAC + freshness      (noise filter)
        + x-signature            │ 2. GET /v2/actor-runs/<runId>  ← with OUR token
                                 │    assert run.userId  === claimed userId
                                 │    assert run.actId   === PUBLISHED_ACTOR_ID
                                 │    assert run.status  === RUNNING
                                 │ 3. look up userId in the KV allow-list
        ◄──{payload, signature}──┤ 4. sign a grant bound to runId, exp = now + 60s
                                 │
     verify Ed25519 signature ───┘
     assert runId / actorId / userId match this run
     assert not expired
     anything else → free, cap 10
```

Step 2 is the whole design. A runner can put anything in the request body; they
cannot make Apify report a run of *our* actor under a user that is not theirs.

## Anti-fork

A fork that strips the gate is not defeated by this service, and pretending
otherwise would be dishonest. What the `PUBLISHED_ACTOR_ID` check does is bind
entitlement to *our* build: a fork runs under a different actor id, so it can never
obtain a grant. It gets no free results from our actor — it has to pay its own
compute, its own proxy, and maintain the query-id registry itself.

Defeating the fork outright requires moving the resource server-side: serving the
query-id registry per entitled run, or relaying results above item 10 through
infrastructure we control. That is a product decision, not a take-home one, but the
actor keeps every capability behind one injectable port so it stays a config change.

## Deploy

```bash
npm create cloudflare@latest entitlements
wrangler secret put APIFY_SERVICE_TOKEN   # our Apify API token — never the runner's
wrangler secret put ACTOR_SHARED_SECRET   # shared with the actor's env vars
wrangler secret put ED25519_PRIVATE_KEY   # base64 PKCS8
wrangler secret put ADMIN_SECRET
wrangler kv namespace create ENTITLEMENTS
wrangler deploy
```

Generate the keypair (the actor only ever holds the public half):

```bash
node -e '
const { generateKeyPairSync } = require("node:crypto");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
console.log("ED25519_PRIVATE_KEY =", privateKey.export({format:"der",type:"pkcs8"}).toString("base64"));
console.log("ENTITLEMENTS_PUBLIC_KEY =", publicKey.export({format:"der",type:"spki"}).toString("base64"));
'
```

## Granting entitlement

```bash
curl -X POST https://<worker>.workers.dev/v1/admin/grant \
  -H "authorization: Bearer $ADMIN_SECRET" \
  -H 'content-type: application/json' \
  -d '{"userId":"<apify user id>","tier":"paid"}'
```

Verify the gate yourself: run the actor with `maxResults: 1000` before granting
(10 items, `limited: true`) and again after (the full amount). Same input, same
build — the only thing that changed lives on a server the runner does not control.
