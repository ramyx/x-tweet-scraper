import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { z } from 'zod';
import type { Clock, Entitlement } from '../domain/types.js';
import { systemClock } from '../domain/types.js';
import { FREE_TIER_CAP } from '../domain/quota.js';
import type { HttpClient } from './http.js';

/**
 * Entitlement resolution (assessment §6).
 *
 * The rule this module exists to enforce: **the client asks, the server decides.**
 * Everything the runner controls — actor input, environment variables, run
 * options — can only influence *who we ask about*, never the answer. Concretely:
 *
 * - The identity below is a *claim*. The service re-checks it against the Apify
 *   API with its own token, so a forged `userId` buys nothing.
 * - The grant is signed and bound to this `runId` and `actorId`, so a paid user's
 *   grant cannot be replayed into somebody else's run.
 * - Pointing `ENTITLEMENTS_URL` at a server you control does not help: a response
 *   that does not verify against the public key compiled into this build is
 *   discarded, and discarding means free.
 * - Every failure path — no config, network error, bad signature, wrong run,
 *   expired grant, malformed body — resolves to free/10. There is no code path
 *   in which an error raises the cap.
 */

/** What the platform tells us about the run. Claims, not proof. */
export interface RunIdentity {
    readonly userId: string | null;
    readonly runId: string | null;
    readonly actorId: string | null;
    /** False for local runs, which have no platform identity to verify. */
    readonly isAtHome: boolean;
}

export interface EntitlementConfig {
    readonly serviceUrl: string | undefined;
    readonly sharedSecret: string | undefined;
    /** Ed25519 public key, base64 SPKI DER. Public by design — it only verifies. */
    readonly publicKey: string | undefined;
}

export interface EntitlementResolverOptions {
    readonly http: HttpClient;
    readonly config: EntitlementConfig;
    readonly identity: RunIdentity;
    readonly clock?: Clock;
    readonly timeoutMs?: number;
    readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

const GrantSchema = z.object({
    payload: z.object({
        tier: z.enum(['free', 'paid']),
        cap: z.number().int().positive().optional(),
        userId: z.string(),
        runId: z.string(),
        actorId: z.string(),
        /** Epoch seconds. Deliberately short-lived. */
        exp: z.number().int().positive(),
    }),
    signature: z.string().min(1),
});

/** The only entitlement any failure may produce. */
function failClosed(reason: string): Entitlement {
    return { tier: 'free', cap: FREE_TIER_CAP, source: 'fail-closed', reason };
}

export async function resolveEntitlement(options: EntitlementResolverOptions): Promise<Entitlement> {
    const log = options.log ?? (() => {});
    const clock = options.clock ?? systemClock;
    const { config, identity } = options;

    if (!identity.isAtHome) {
        // A local run has no platform identity, so there is nothing to verify.
        return failClosed('local_run');
    }
    if (identity.userId === null || identity.runId === null || identity.actorId === null) {
        return failClosed('incomplete_run_identity');
    }
    if (config.serviceUrl === undefined || config.sharedSecret === undefined || config.publicKey === undefined) {
        log('entitlement: service is not configured, treating the run as free');
        return failClosed('not_configured');
    }

    const body = JSON.stringify({
        userId: identity.userId,
        runId: identity.runId,
        actorId: identity.actorId,
        nonce: randomNonce(),
        ts: Math.floor(clock.now().getTime() / 1000),
    });

    let responseBody: string;
    try {
        const response = await options.http.request({
            url: config.serviceUrl,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-signature': createHmac('sha256', config.sharedSecret).update(body).digest('hex'),
            },
            body,
            timeoutMs: options.timeoutMs ?? 8000,
        });

        if (response.status !== 200) {
            log('entitlement: service refused', { status: response.status });
            return failClosed(`service_status_${response.status}`);
        }
        responseBody = response.body;
    } catch (error: unknown) {
        log('entitlement: service unreachable', { error: String(error) });
        return failClosed('service_unreachable');
    }

    return verifyGrant(responseBody, { config, identity, clock, log });
}

function verifyGrant(
    responseBody: string,
    context: {
        config: EntitlementConfig;
        identity: RunIdentity;
        clock: Clock;
        log: (message: string, data?: Record<string, unknown>) => void;
    },
): Entitlement {
    const { config, identity, clock, log } = context;

    let parsed: unknown;
    try {
        parsed = JSON.parse(responseBody);
    } catch {
        return failClosed('malformed_response');
    }

    const grant = GrantSchema.safeParse(parsed);
    if (!grant.success) return failClosed('malformed_grant');

    const { payload, signature } = grant.data;

    if (!signatureIsValid(payload, signature, config.publicKey)) {
        log('entitlement: grant signature did not verify');
        return failClosed('bad_signature');
    }

    // Binding to the run is what stops a paid user's grant being replayed here.
    if (payload.runId !== identity.runId) return failClosed('run_mismatch');
    if (payload.actorId !== identity.actorId) return failClosed('actor_mismatch');
    if (payload.userId !== identity.userId) return failClosed('user_mismatch');
    if (payload.exp * 1000 <= clock.now().getTime()) return failClosed('grant_expired');

    if (payload.tier !== 'paid') {
        return { tier: 'free', cap: FREE_TIER_CAP, source: 'service', reason: 'free_tier' };
    }

    return {
        tier: 'paid',
        cap: payload.cap ?? Number.POSITIVE_INFINITY,
        source: 'service',
        reason: null,
    };
}

function signatureIsValid(payload: unknown, signature: string, publicKeyBase64: string | undefined): boolean {
    if (publicKeyBase64 === undefined) return false;

    try {
        const key = createPublicKey({
            key: Buffer.from(publicKeyBase64, 'base64'),
            format: 'der',
            type: 'spki',
        });
        return verifySignature(
            null,
            Buffer.from(canonical(payload)),
            key,
            Buffer.from(signature, 'base64'),
        );
    } catch {
        return false;
    }
}

/** Signed and verified over the same bytes: keys sorted, no incidental whitespace. */
export function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);

    return `{${entries.join(',')}}`;
}

function randomNonce(): string {
    return [...crypto.getRandomValues(new Uint8Array(16))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/** Constant-time comparison, for the service side and for tests. */
export function secretsMatch(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
