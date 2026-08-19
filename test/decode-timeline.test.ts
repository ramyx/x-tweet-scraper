import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeUserTimeline, type DecodedPage } from '../src/x/decode/timeline.js';

function fixture(name: string): unknown {
    return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

function decodeOk(body: unknown): DecodedPage {
    const result = decodeUserTimeline(body);
    if (!result.ok) throw new Error(`expected a page, got ${result.reason}: ${result.message}`);
    return result.page;
}

/**
 * Minimal envelope so structural tests do not depend on a 800 KB fixture.
 * Mirrors the real payload, where `data.user.result` is only `{ __typename,
 * timeline }` — the timeline surface returns no profile fields at all.
 */
function timeline(instructions: unknown[]): unknown {
    return {
        data: {
            user: { result: { __typename: 'User', timeline: { timeline: { instructions } } } },
        },
    };
}

function tweetEntry(id: string): unknown {
    return {
        entryId: `tweet-${id}`,
        content: {
            entryType: 'TimelineTimelineItem',
            itemContent: {
                __typename: 'TimelineTweet',
                tweet_results: {
                    result: {
                        rest_id: id,
                        core: { user_results: { result: { rest_id: '2', core: { name: 'A', screen_name: 'a' } } } },
                        legacy: { created_at: 'Wed Mar 05 11:22:33 +0000 2025', full_text: `t${id}` },
                    },
                },
            },
        },
    };
}

function cursorEntry(type: 'Top' | 'Bottom', value: string): unknown {
    return {
        entryId: `cursor-${type.toLowerCase()}-1`,
        content: { entryType: 'TimelineTimelineCursor', cursorType: type, value },
    };
}

describe('decodeUserTimeline', () => {
    describe('against the captured UserTweets page', () => {
        const page = decodeOk(fixture('user-tweets.apify.page1.json'));

        it('recovers every tweet, including those inside conversation modules', () => {
            // 18 entries yield 20 tweets: 4 of them are thread modules. A decoder
            // that only reads `tweet-*` entries would return 16 and look fine.
            expect(page.tweets).toHaveLength(20);
        });

        it('extracts the Bottom cursor for the next page', () => {
            expect(page.cursor).toMatch(/^DAAHCgAB/);
        });

        it('does not emit the pinned tweet twice', () => {
            const ids = page.tweets.map((t) => t.id);

            expect(new Set(ids).size).toBe(ids.length);
        });
    });

    describe('cursors', () => {
        it('takes Bottom and ignores Top, which pages backwards', () => {
            const page = decodeOk(
                timeline([
                    {
                        type: 'TimelineAddEntries',
                        entries: [cursorEntry('Top', 'TOP'), tweetEntry('1'), cursorEntry('Bottom', 'BOTTOM')],
                    },
                ]),
            );

            expect(page.cursor).toBe('BOTTOM');
            expect(page.tweets).toHaveLength(1);
        });

        it('reports no cursor when the timeline ends', () => {
            const page = decodeOk(timeline([{ type: 'TimelineAddEntries', entries: [tweetEntry('1')] }]));

            expect(page.cursor).toBeNull();
        });

        it('returns an empty page with a cursor without crashing (the end-of-timeline trap)', () => {
            const page = decodeOk(
                timeline([{ type: 'TimelineAddEntries', entries: [cursorEntry('Bottom', 'SAME')] }]),
            );

            expect(page.tweets).toEqual([]);
            expect(page.cursor).toBe('SAME');
        });
    });

    describe('entries that are not results', () => {
        it('skips the pinned entry instruction entirely', () => {
            const page = decodeOk(
                timeline([
                    { type: 'TimelinePinEntry', entry: tweetEntry('999') },
                    { type: 'TimelineAddEntries', entries: [tweetEntry('1')] },
                ]),
            );

            expect(page.tweets.map((t) => t.id)).toEqual(['1']);
        });

        it('skips promoted content and counts it', () => {
            const promoted = {
                entryId: 'promoted-tweet-5',
                content: {
                    entryType: 'TimelineTimelineItem',
                    itemContent: { __typename: 'TimelineTweet', promotedMetadata: {}, tweet_results: { result: {} } },
                },
            };
            const page = decodeOk(
                timeline([{ type: 'TimelineAddEntries', entries: [promoted, tweetEntry('1')] }]),
            );

            expect(page.tweets).toHaveLength(1);
            expect(page.skipped.promoted).toBe(1);
        });

        it('counts tombstones instead of failing the page', () => {
            const tombstone = {
                entryId: 'tweet-7',
                content: {
                    entryType: 'TimelineTimelineItem',
                    itemContent: {
                        __typename: 'TimelineTweet',
                        tweet_results: { result: { __typename: 'TweetTombstone' } },
                    },
                },
            };
            const page = decodeOk(
                timeline([{ type: 'TimelineAddEntries', entries: [tombstone, tweetEntry('1')] }]),
            );

            expect(page.tweets).toHaveLength(1);
            expect(page.skipped.tombstone).toBe(1);
        });

        it('ignores instructions it does not understand', () => {
            const page = decodeOk(
                timeline([
                    { type: 'TimelineClearCache' },
                    { type: 'TimelineAddEntries', entries: [tweetEntry('1')] },
                    { type: 'TimelineTerminateTimeline' },
                ]),
            );

            expect(page.tweets).toHaveLength(1);
        });
    });

    describe('accounts we cannot read', () => {
        it('reports a withheld account when the timeline says so', () => {
            // A `privacy.protected` account is caught earlier, on the profile call:
            // this surface carries no profile fields to inspect.
            const body = { data: { user: { result: { __typename: 'UserUnavailable', reason: 'Protected' } } } };

            expect(decodeUserTimeline(body)).toMatchObject({ ok: false, reason: 'protected' });
        });

        it('reports suspended accounts', () => {
            const body = { data: { user: { result: { __typename: 'UserUnavailable', reason: 'Suspended' } } } };

            expect(decodeUserTimeline(body)).toMatchObject({ ok: false, reason: 'suspended' });
        });

        it('reports a missing handle from the GraphQL error', () => {
            const body = { data: {}, errors: [{ message: 'Could not find user' }] };

            expect(decodeUserTimeline(body)).toMatchObject({ ok: false, reason: 'not_found' });
        });

        it('does not throw on nonsense', () => {
            expect(decodeUserTimeline(null)).toMatchObject({ ok: false });
            expect(decodeUserTimeline('nope')).toMatchObject({ ok: false });
        });

        it('returns an empty page, not an error, when a timeline is simply empty', () => {
            const page = decodeOk(timeline([]));

            expect(page).toEqual({ tweets: [], cursor: null, skipped: {} });
        });
    });
});
