import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeUserByScreenName, decodeUserResult } from '../src/x/decode/user.js';

function fixture(name: string): unknown {
    return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

describe('decodeUserResult', () => {
    it('decodes a real UserByScreenName response', () => {
        const result = decodeUserByScreenName(fixture('user-by-screen-name.apify.json'));

        expect(result).toEqual({
            ok: true,
            user: {
                author: {
                    id: '3510729917',
                    username: 'apify',
                    name: 'Apify',
                    verified: true,
                    followers: expect.any(Number),
                    following: expect.any(Number),
                },
                isProtected: false,
            },
        });
    });

    it('reads the author fields from `core`, not the retired `legacy` node', () => {
        // Regression guard: X moved these in 2026. A decoder written against
        // `legacy.screen_name` decodes to nothing while still "working".
        const withLegacyOnly = {
            rest_id: '1',
            legacy: { screen_name: 'ghost', name: 'Ghost', followers_count: 99, friends_count: 9 },
        };

        expect(decodeUserResult(withLegacyOnly).ok).toBe(false);
    });

    it('maps follower counts from relationship_counts', () => {
        const result = decodeUserResult({
            rest_id: '12',
            core: { name: 'jack', screen_name: 'jack' },
            relationship_counts: { followers: 11460767, following: 3 },
        });

        expect(result.ok && result.user.author.followers).toBe(11460767);
        expect(result.ok && result.user.author.following).toBe(3);
    });

    it('defaults missing counts to 0 rather than failing', () => {
        const result = decodeUserResult({ rest_id: '1', core: { name: 'A', screen_name: 'a' } });

        expect(result.ok && result.user.author.followers).toBe(0);
        expect(result.ok && result.user.author.following).toBe(0);
    });

    describe('verified: any current X program counts', () => {
        const base = { rest_id: '1', core: { name: 'A', screen_name: 'a' } };
        const verifiedOf = (extra: object): boolean => {
            const r = decodeUserResult({ ...base, ...extra });
            return r.ok && r.user.author.verified;
        };

        it('legacy-style verification flag', () => {
            expect(verifiedOf({ verification: { verified: true } })).toBe(true);
        });

        it('blue only — @jack: is_blue_verified true, verification.verified false', () => {
            expect(verifiedOf({ is_blue_verified: true, verification: { verified: false } })).toBe(true);
        });

        it('verified_type only — @apify: neither flag set, but Business', () => {
            expect(
                verifiedOf({
                    is_blue_verified: false,
                    verification: { verified: false, verified_type: 'Business' },
                }),
            ).toBe(true);
        });

        it('none of the three', () => {
            expect(verifiedOf({ is_blue_verified: false, verification: { verified: false } })).toBe(false);
            expect(verifiedOf({})).toBe(false);
        });
    });

    describe('accounts we cannot read', () => {
        it('flags protected accounts without failing the decode', () => {
            const result = decodeUserResult({
                rest_id: '1',
                core: { name: 'A', screen_name: 'a' },
                privacy: { protected: true },
            });

            expect(result.ok && result.user.isProtected).toBe(true);
        });

        it('reports suspended accounts', () => {
            const result = decodeUserResult({ __typename: 'UserUnavailable', reason: 'Suspended' });

            expect(result).toMatchObject({ ok: false, reason: 'suspended' });
        });

        it('reports a missing handle from the GraphQL error', () => {
            const result = decodeUserByScreenName({
                data: {},
                errors: [{ message: 'Could not find user with screen_name' }],
            });

            expect(result).toMatchObject({
                ok: false,
                reason: 'not_found',
                message: 'Could not find user with screen_name',
            });
        });

        it('does not throw on an unrecognisable payload', () => {
            expect(decodeUserResult(null)).toMatchObject({ ok: false });
            expect(decodeUserResult('nonsense')).toMatchObject({ ok: false });
            expect(decodeUserByScreenName({ unexpected: true })).toMatchObject({ ok: false });
        });
    });
});
