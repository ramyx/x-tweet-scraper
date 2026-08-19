# Setup

Three things to stand up: the actor on **Apify**, the entitlements service on
**Cloudflare**, and the wiring between them. Local development needs neither.

---

## 1. Run it locally (no accounts needed)

```bash
git clone https://github.com/ramyx/x-tweet-scraper.git
cd x-tweet-scraper
npm ci
npm run check          # typecheck + lint + 170 tests, all offline
```

To run the actor itself against live X:

```bash
npm run build
mkdir -p storage/key_value_stores/default
cat > storage/key_value_stores/default/INPUT.json <<'EOF'
{ "fromUsers": ["apify"], "maxResults": 5, "proxyConfiguration": { "useApifyProxy": false } }
EOF
node dist/main.js
```

Results land in `storage/datasets/default/`.

> A local run has no platform identity to verify, so entitlement resolves to
> `free` with reason `local_run`. That is the fail-closed path working as designed:
> the safe answer is the default, not something you have to configure.

---

## 2. Apify

### 2.1 Account and CLI

1. Create an account at <https://console.apify.com/sign-up>.
2. Install and log in:

```bash
npm install -g apify-cli
apify login          # token from Settings → Integrations → API token
```

3. Note three values you will need — Apify calls them by these names:

| Value | Where |
|---|---|
| **API token** | Settings → Integrations |
| **User ID** | Settings → Account |
| **Actor ID** | the actor's URL, after you first push |

### 2.2 Deploy

```bash
apify push
```

This builds the Docker image from the repo's `Dockerfile` and creates the actor
named in `.actor/actor.json` (`x-tweet-scraper`). The first push prints the actor
URL; take the actor id from it.

### 2.3 Environment variables

Actor → **Settings → Environment variables**, all marked **secret**:

| Variable | Value |
|---|---|
| `ENTITLEMENTS_URL` | `https://<your-worker>.workers.dev/v1/check` |
| `ENTITLEMENTS_SHARED_SECRET` | the same value you give the worker |
| `ENTITLEMENTS_PUBLIC_KEY` | base64 SPKI Ed25519 **public** key (§3.2) |

These only say *where to ask*. Faking them cannot raise the cap: a response that
does not verify against the public key is discarded, and discarding means free.

### 2.4 Proxy

The default input uses residential proxy, which is what the performance benchmark
assumes. Check availability under **Proxy** in the console — residential is billed
per GB and is not always enabled on a new account. If it is not available, run with
`{"useApifyProxy": true, "apifyProxyGroups": ["DATACENTER"]}` and say so alongside
any timing you report; a labelled number is worth more than an unlabelled one.

---

## 3. Cloudflare (the entitlements service)

### 3.1 Create the worker

```bash
npm install -g wrangler
wrangler login

cd entitlements
cp wrangler.example.toml wrangler.toml
wrangler kv namespace create ENTITLEMENTS     # paste the id into wrangler.toml
```

Set `PUBLISHED_ACTOR_ID` in `wrangler.toml` to the actor id from §2.2. That value
is the anti-fork pin: grants are only issued for runs of that actor.

### 3.2 Generate the signing keypair

The worker signs; the actor only verifies. The actor never holds the private half.

```bash
node -e '
const { generateKeyPairSync } = require("node:crypto");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
console.log("ED25519_PRIVATE_KEY      =", privateKey.export({format:"der",type:"pkcs8"}).toString("base64"));
console.log("ENTITLEMENTS_PUBLIC_KEY  =", publicKey.export({format:"der",type:"spki"}).toString("base64"));
'
```

### 3.3 Secrets and deploy

```bash
wrangler secret put APIFY_SERVICE_TOKEN   # YOUR Apify API token — never a runner's
wrangler secret put ACTOR_SHARED_SECRET   # any random 32+ chars; also goes in the actor env
wrangler secret put ED25519_PRIVATE_KEY   # from §3.2
wrangler secret put ADMIN_SECRET          # any random 32+ chars, for granting entitlements

wrangler deploy
curl https://<your-worker>.workers.dev/v1/health     # {"ok":true}
```

`APIFY_SERVICE_TOKEN` is what makes the check authoritative: the worker asks the
Apify API *itself* who owns the run being presented, instead of believing the
caller. Nothing the runner controls participates in that step.

---

## 4. Granting entitlement

```bash
curl -X POST https://<your-worker>.workers.dev/v1/admin/grant \
  -H "authorization: Bearer $ADMIN_SECRET" \
  -H 'content-type: application/json' \
  -d '{"userId":"<apify user id>","tier":"paid"}'
```

---

## 5. Verifying the gate yourself

Both runs use the **same input, the same build and the same account**. The only
thing that changes lives on a server the runner does not control.

```bash
# 1. Before granting — expect exactly 10 items and limited: true
#    Input: { "fromUsers": ["apify"], "maxResults": 1000 }

# 2. Grant (§4), then run the identical input again
#    Expect the full requested amount and limited: false
```

Check `RUN_SUMMARY` in the run's key-value store for
`{ limited, reason, cap, pushed, requested }`.

Note that you do **not** need to pay for anything to demonstrate the paid path:
"free" and "paid" here mean our own allow-list, not an Apify plan.

---

## 6. Troubleshooting

| Symptom | Cause |
|---|---|
| `entitlement resolved {"source":"fail-closed","reason":"local_run"}` | Running locally. Expected. |
| `reason: "not_configured"` | The three actor env vars are missing. |
| `reason: "service_unreachable"` | Wrong `ENTITLEMENTS_URL`, or the worker is down. Fail-closed is working. |
| `reason: "bad_signature"` | `ENTITLEMENTS_PUBLIC_KEY` does not match the worker's private key. |
| `reason: "actor_mismatch"` | `PUBLISHED_ACTOR_ID` in `wrangler.toml` is not this actor. |
| Worker returns `403 not our actor` | Same as above, seen from the service side. |
| Worker returns `403 unknown run` | `APIFY_SERVICE_TOKEN` cannot read the run — check it is your own account's token. |
