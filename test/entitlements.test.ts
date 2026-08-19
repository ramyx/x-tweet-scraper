import { generateKeyPairSync, sign as signWith } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    canonical,
    resolveEntitlement,
    type EntitlementConfig,
    type RunIdentity,
} from '../src/infra/entitlements.js';
import { FREE_TIER_CAP } from '../src/domain/quota.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/infra/http.js';
import type { Clock, Entitlement } from '../src/domain/types.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY_B64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

/** A second keypair, standing in for anyone who runs their own fake service. */
const impostor = generateKeyPairSync('ed25519');

const IDENTITY: RunIdentity = {
    userId: 'user-1',
    runId: 'run-1',
    actorId: 'actor-1',
    isAtHome: true,
};

const CONFIG: EntitlementConfig = {
    serviceUrl: 'https://entitlements.example/v1/check',
    sharedSecret: 'shhh',
    publicKey: PUBLIC_KEY_B64,
};

const clock: Clock = { now: () => new Date('2026-08-19T12:00:00.000Z') };
const NOW_SECONDS = Math.floor(clock.now().getTime() / 1000);

function sign(payload: object, key = privateKey): string {
    return signWith(null, Buffer.from(canonical(payload)), key).toString('base64');
}

function grantFor(overrides: Record<string, unknown> = {}, key = privateKey): string {
    const payload = {
        tier: 'paid',
        userId: 'user-1',
        runId: 'run-1',
        actorId: 'actor-1',
        exp: NOW_SECONDS + 60,
        ...overrides,
    };
    return JSON.stringify({ payload, signature: sign(payload, key) });
}

function httpReturning(response: Partial<HttpResponse> | Error): HttpClient & { calls: HttpRequest[] } {
    const calls: HttpRequest[] = [];
    return {
        calls,
        async request(request: HttpRequest): Promise<HttpResponse> {
            calls.push(request);
            if (response instanceof Error) throw response;
            return { status: 200, headers: {}, body: '', ...response };
        },
        async close(): Promise<void> {},
    };
}

const resolve = (http: HttpClient, over: Partial<{ config: EntitlementConfig; identity: RunIdentity }> = {}) =>
    resolveEntitlement({
        http,
        clock,
        config: over.config ?? CONFIG,
        identity: over.identity ?? IDENTITY,
    });

describe('resolveEntitlement', () => {
    it('grants the paid tier for a valid, run-bound, signed grant', async () => {
        const entitlement = await resolve(httpReturning({ body: grantFor() }));

        expect(entitlement).toEqual({
            tier: 'paid',
            cap: Number.POSITIVE_INFINITY,
            source: 'service',
            reason: null,
        });
    });

    it('honours an explicit cap from the service', async () => {
        const entitlement = await resolve(httpReturning({ body: grantFor({ cap: 5000 }) }));

        expect(entitlement.cap).toBe(5000);
    });

    it('signs the request so the service can reject internet noise', async () => {
        const http = httpReturning({ body: grantFor() });
        await resolve(http);

        expect(http.calls[0]?.headers?.['x-signature']).toMatch(/^[0-9a-f]{64}$/);
        expect(http.calls[0]?.method).toBe('POST');
    });

    describe('fail-closed: every failure resolves to free/10', () => {
        const cases: Array<[string, () => Promise<Entitlement>]> = [
            ['the service is unreachable', () => resolve(httpReturning(new Error('ECONNREFUSED')))],
            ['the service returns 500', () => resolve(httpReturning({ status: 500, body: 'boom' }))],
            ['the service returns 403', () => resolve(httpReturning({ status: 403, body: '' }))],
            ['the body is not JSON', () => resolve(httpReturning({ body: 'not json' }))],
            ['the grant is missing fields', () => resolve(httpReturning({ body: '{"payload":{}}' }))],
            [
                'the signature is from another key',
                () => resolve(httpReturning({ body: grantFor({}, impostor.privateKey) })),
            ],
            [
                'the payload was altered after signing',
                () =>
                    resolve(
                        httpReturning({
                            body: JSON.stringify({
                                payload: { tier: 'paid', userId: 'user-1', runId: 'run-1', actorId: 'actor-1', exp: NOW_SECONDS + 60 },
                                signature: sign({ tier: 'free', userId: 'user-1', runId: 'run-1', actorId: 'actor-1', exp: NOW_SECONDS + 60 }),
                            }),
                        }),
                    ),
            ],
            ['the grant was minted for another run', () => resolve(httpReturning({ body: grantFor({ runId: 'run-2' }) }))],
            ['the grant was minted for a forked actor', () => resolve(httpReturning({ body: grantFor({ actorId: 'actor-2' }) }))],
            ['the grant names another user', () => resolve(httpReturning({ body: grantFor({ userId: 'user-2' }) }))],
            ['the grant has expired', () => resolve(httpReturning({ body: grantFor({ exp: NOW_SECONDS - 1 }) }))],
            [
                'the service is not configured',
                () => resolve(httpReturning({ body: grantFor() }), { config: { serviceUrl: undefined, sharedSecret: undefined, publicKey: undefined } }),
            ],
            [
                'the run is local, with no platform identity',
                () => resolve(httpReturning({ body: grantFor() }), { identity: { ...IDENTITY, isAtHome: false } }),
            ],
            [
                'the platform identity is incomplete',
                () => resolve(httpReturning({ body: grantFor() }), { identity: { ...IDENTITY, userId: null } }),
            ],
        ];

        for (const [description, run] of cases) {
            it(`caps at ${FREE_TIER_CAP} when ${description}`, async () => {
                const entitlement = await run();

                expect(entitlement.tier).toBe('free');
                expect(entitlement.cap).toBe(FREE_TIER_CAP);
                expect(entitlement.source).toBe('fail-closed');
            });
        }

        it('no failure path can ever produce the paid tier', async () => {
            const results = await Promise.all(cases.map(([, run]) => run()));

            expect(results.every((e) => e.tier === 'free' && e.cap === FREE_TIER_CAP)).toBe(true);
        });
    });

    it('reports a service-issued free tier as coming from the service, not a failure', async () => {
        const entitlement = await resolve(httpReturning({ body: grantFor({ tier: 'free' }) }));

        expect(entitlement).toMatchObject({ tier: 'free', cap: FREE_TIER_CAP, source: 'service' });
    });

    it('never asks the service when the run is local', async () => {
        const http = httpReturning({ body: grantFor() });
        await resolve(http, { identity: { ...IDENTITY, isAtHome: false } });

        expect(http.calls).toEqual([]);
    });
});

describe('canonical', () => {
    it('is stable under key ordering, so signer and verifier hash the same bytes', () => {
        expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
        expect(canonical({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
    });

    it('handles nested structures and drops undefined', () => {
        expect(canonical({ z: [1, { y: 'x' }], u: undefined })).toBe('{"z":[1,{"y":"x"}]}');
    });
});
