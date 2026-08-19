/**
 * Entitlements service — a Cloudflare Worker.
 *
 * This is the authority behind the actor's free-tier gate (assessment §6). The
 * actor asks; this decides. The design point is step 2 of `check()`: the caller's
 * claimed identity is **re-derived from the Apify API using our own token**, so a
 * forged `userId` is worthless, and a fork cannot pass because the run it presents
 * does not belong to our published actor id.
 *
 * Deploy:
 *   wrangler secret put APIFY_SERVICE_TOKEN   # our Apify API token, never the runner's
 *   wrangler secret put ACTOR_SHARED_SECRET   # HMAC gate against internet noise
 *   wrangler secret put ED25519_PRIVATE_KEY   # base64 PKCS8; the actor holds only the public half
 *   wrangler secret put ADMIN_SECRET          # for granting entitlements
 *   wrangler deploy
 */

export interface Env {
    ENTITLEMENTS: KVNamespace;
    APIFY_SERVICE_TOKEN: string;
    ACTOR_SHARED_SECRET: string;
    ED25519_PRIVATE_KEY: string;
    ADMIN_SECRET: string;
    /** The actor id of our published build. The anti-fork pin. */
    PUBLISHED_ACTOR_ID: string;
}

interface CheckRequest {
    userId: string;
    runId: string;
    actorId: string;
    nonce: string;
    ts: number;
}

const CLOCK_SKEW_SECONDS = 120;
const GRANT_TTL_SECONDS = 60;

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/v1/health') return json({ ok: true });
        if (url.pathname === '/v1/admin/grant') return admin(request, env);
        if (url.pathname !== '/v1/check') return json({ error: 'not found' }, 404);
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

        return check(request, env);
    },
};

async function check(request: Request, env: Env): Promise<Response> {
    const body = await request.text();

    // 1. Cheap gate. This stops random traffic; it is NOT the security boundary.
    const provided = request.headers.get('x-signature') ?? '';
    if (!timingSafeEqualHex(provided, await hmacHex(env.ACTOR_SHARED_SECRET, body))) {
        return json({ error: 'bad signature' }, 401);
    }

    let claim: CheckRequest;
    try {
        claim = JSON.parse(body) as CheckRequest;
    } catch {
        return json({ error: 'malformed body' }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(claim.ts) || Math.abs(now - claim.ts) > CLOCK_SKEW_SECONDS) {
        return json({ error: 'stale request' }, 400);
    }

    // 2. THE SECURITY BOUNDARY. Everything above is the caller's word for it;
    //    this is us asking Apify, with our own token, who actually owns this run.
    const run = await fetchRun(claim.runId, env.APIFY_SERVICE_TOKEN);
    if (run === null) return json({ error: 'unknown run' }, 403);
    if (run.userId !== claim.userId) return json({ error: 'run does not belong to that user' }, 403);
    if (run.actId !== env.PUBLISHED_ACTOR_ID) return json({ error: 'not our actor' }, 403);
    if (run.status !== 'RUNNING') return json({ error: 'run is not active' }, 403);

    // 3. Our own allow-list — the part a real billing system would replace.
    const record = await env.ENTITLEMENTS.get(claim.userId, 'json');
    const tier = isPaid(record) ? 'paid' : 'free';

    // 4. A grant bound to this run, and short-lived, so it cannot be replayed.
    const payload = {
        tier,
        userId: claim.userId,
        runId: claim.runId,
        actorId: run.actId,
        exp: now + GRANT_TTL_SECONDS,
    };

    return json({ payload, signature: await signEd25519(env.ED25519_PRIVATE_KEY, canonical(payload)) });
}

interface ApifyRun {
    userId: string;
    actId: string;
    status: string;
}

/** Reads the run from Apify with OUR token. The runner's token never appears here. */
async function fetchRun(runId: string, token: string): Promise<ApifyRun | null> {
    if (typeof runId !== 'string' || runId.length === 0) return null;

    const response = await fetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`, {
        headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { data?: ApifyRun };
    return body.data ?? null;
}

function isPaid(record: unknown): boolean {
    if (record === null || typeof record !== 'object') return false;
    const entry = record as { tier?: unknown; until?: unknown };
    if (entry.tier !== 'paid') return false;
    if (typeof entry.until === 'string' && Date.parse(entry.until) < Date.now()) return false;
    return true;
}

async function admin(request: Request, env: Env): Promise<Response> {
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!timingSafeEqualHex(token, env.ADMIN_SECRET)) return json({ error: 'unauthorized' }, 401);

    const { userId, tier, until } = (await request.json()) as {
        userId?: string;
        tier?: string;
        until?: string;
    };
    if (typeof userId !== 'string' || (tier !== 'paid' && tier !== 'free')) {
        return json({ error: 'userId and tier are required' }, 400);
    }

    await env.ENTITLEMENTS.put(userId, JSON.stringify({ tier, until: until ?? null }));
    return json({ ok: true, userId, tier });
}

// --- crypto helpers ---------------------------------------------------------

async function hmacHex(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signEd25519(privateKeyBase64: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'pkcs8',
        base64ToBytes(privateKeyBase64),
        { name: 'Ed25519' },
        false,
        ['sign'],
    );
    const signature = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(message));
    return bytesToBase64(new Uint8Array(signature));
}

/** Must match the actor's `canonical()` byte for byte. */
function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);

    return `{${entries.join(',')}}`;
}

function timingSafeEqualHex(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function base64ToBytes(value: string): Uint8Array {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}
