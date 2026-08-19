import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeTweetResult } from '../src/x/decode/tweet.js';
import type { TweetEntity } from '../src/domain/types.js';

function fixture(name: string): unknown {
    return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

/** Fixtures are untyped JSON. These walk them without spraying `any` around. */
function at(node: unknown, ...path: string[]): unknown {
    let current = node;
    for (const key of path) {
        if (current == null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

function asArray(node: unknown): unknown[] {
    return Array.isArray(node) ? node : [];
}

function entryId(entry: unknown): string {
    const id = at(entry, 'entryId');
    return typeof id === 'string' ? id : '';
}

/** Pulls every tweet node out of a captured timeline, threads included. */
function timelineTweets(): unknown[] {
    const instructions = asArray(
        at(fixture('user-tweets.apify.page1.json'), 'data', 'user', 'result', 'timeline', 'timeline', 'instructions'),
    );
    const entries = asArray(
        at(instructions.find((i) => at(i, 'type') === 'TimelineAddEntries'), 'entries'),
    );

    const out: unknown[] = [];
    for (const entry of entries) {
        if (entryId(entry).startsWith('tweet-')) {
            out.push(at(entry, 'content', 'itemContent', 'tweet_results', 'result'));
        } else if (entryId(entry).startsWith('profile-conversation-')) {
            for (const item of asArray(at(entry, 'content', 'items'))) {
                out.push(at(item, 'item', 'itemContent', 'tweet_results', 'result'));
            }
        }
    }
    return out;
}

const tweet20 = (): unknown => at(fixture('tweet-result.20.json'), 'data', 'tweetResult', 'result');

function decodeOk(raw: unknown): TweetEntity {
    const result = decodeTweetResult(raw);
    if (!result.ok) throw new Error(`expected a decoded tweet, got: ${result.message}`);
    return result.tweet;
}

describe('decodeTweetResult', () => {
    it('decodes a real TweetResultByRestId response', () => {
        const tweet = decodeOk(tweet20());

        expect(tweet.id).toBe('20');
        expect(tweet.text).toBe('just setting up my twttr');
        expect(tweet.author.username).toBe('jack');
        expect(tweet.author.verified).toBe(true);
        expect(tweet.createdAt.toISOString()).toBe('2006-03-21T20:50:14.000Z');
        expect(tweet.isRetweet).toBe(false);
        expect(tweet.isReply).toBe(false);
    });

    it('decodes every tweet in a captured timeline without throwing', () => {
        const decoded = timelineTweets().map(decodeTweetResult);

        expect(decoded).toHaveLength(20);
        expect(decoded.every((r) => r.ok)).toBe(true);
    });

    describe('retweets', () => {
        it('keeps the retweeter as author but takes the content from the inner tweet', () => {
            const raw = timelineTweets().find(
                (t) => at(t, 'legacy', 'retweeted_status_result') != null,
            );
            const tweet = decodeOk(raw);

            expect(tweet.isRetweet).toBe(true);
            expect(tweet.author.username).toBe('apify');
            // The wrapper's own full_text is the truncated "RT @user: …" string.
            expect(tweet.text.startsWith('RT @')).toBe(false);
        });
    });

    describe('media', () => {
        const mediaOf = (kind: string): TweetEntity =>
            decodeOk(
                timelineTweets().find((t) =>
                    asArray(at(t, 'legacy', 'extended_entities', 'media')).some(
                        (m) => at(m, 'type') === kind,
                    ),
                ),
            );

        it('uses the full image for photos, with no thumbnail', () => {
            const photo = mediaOf('photo').entities.media.find((m) => m.type === 'photo');

            expect(photo?.url).toMatch(/^https:\/\/pbs\.twimg\.com\//);
            expect(photo?.thumbnail).toBeNull();
        });

        it('picks the highest-bitrate mp4 for video, and a poster frame', () => {
            const video = mediaOf('video').entities.media.find((m) => m.type === 'video');

            expect(video?.url).toMatch(/\.mp4/);
            expect(video?.thumbnail).toMatch(/^https:\/\/pbs\.twimg\.com\//);
        });

        it('ignores HLS playlists, which are not directly usable', () => {
            const tweet = decodeOk({
                rest_id: '1',
                core: { user_results: { result: { rest_id: '2', core: { name: 'A', screen_name: 'a' } } } },
                legacy: {
                    created_at: 'Wed Mar 05 11:22:33 +0000 2025',
                    extended_entities: {
                        media: [
                            {
                                type: 'video',
                                media_url_https: 'https://pbs.twimg.com/thumb.jpg',
                                video_info: {
                                    variants: [
                                        { content_type: 'application/x-mpegURL', url: 'https://v/playlist.m3u8' },
                                        { content_type: 'video/mp4', bitrate: 432000, url: 'https://v/low.mp4' },
                                        { content_type: 'video/mp4', bitrate: 2176000, url: 'https://v/high.mp4' },
                                        { content_type: 'video/mp4', bitrate: 832000, url: 'https://v/mid.mp4' },
                                    ],
                                },
                            },
                        ],
                    },
                },
            });

            expect(tweet.entities.media).toEqual([
                { type: 'video', url: 'https://v/high.mp4', thumbnail: 'https://pbs.twimg.com/thumb.jpg' },
            ]);
        });
    });

    describe('text', () => {
        const withLegacy = (legacy: object, extra: object = {}): TweetEntity =>
            decodeOk({
                rest_id: '1',
                core: { user_results: { result: { rest_id: '2', core: { name: 'A', screen_name: 'a' } } } },
                legacy: { created_at: 'Wed Mar 05 11:22:33 +0000 2025', ...legacy },
                ...extra,
            });

        it('expands t.co links to their destination', () => {
            const tweet = withLegacy({
                full_text: 'read this https://t.co/abc',
                entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://apify.com/blog' }] },
            });

            expect(tweet.text).toBe('read this https://apify.com/blog');
            expect(tweet.entities.urls).toEqual(['https://apify.com/blog']);
        });

        it('strips the trailing media shortlink, which is not part of the message', () => {
            const tweet = withLegacy({
                full_text: 'look at this https://t.co/media1',
                extended_entities: {
                    media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/x.jpg', url: 'https://t.co/media1' }],
                },
            });

            expect(tweet.text).toBe('look at this');
        });

        it('decodes HTML entities X escapes on the way out', () => {
            expect(withLegacy({ full_text: 'apify &amp; friends &lt;3' }).text).toBe('apify & friends <3');
        });

        it('prefers long-form note_tweet text over the truncated full_text', () => {
            const tweet = withLegacy(
                { full_text: 'truncated…' },
                { note_tweet: { note_tweet_results: { result: { text: 'the whole long post' } } } },
            );

            expect(tweet.text).toBe('the whole long post');
        });
    });

    describe('absent values become null, never undefined', () => {
        const bare = decodeOk({
            rest_id: '1',
            core: { user_results: { result: { rest_id: '2', core: { name: 'A', screen_name: 'a' } } } },
            legacy: { created_at: 'Wed Mar 05 11:22:33 +0000 2025', full_text: 'hi' },
        });

        it('nulls the optional scalars', () => {
            expect(bare.lang).toBeNull();
            expect(bare.conversationId).toBeNull();
            expect(bare.inReplyToId).toBeNull();
            expect(bare.quotedTweetId).toBeNull();
            expect(bare.source).toBeNull();
            expect(bare.metrics.views).toBeNull();
            expect(bare.metrics.bookmarks).toBeNull();
        });

        it('defaults every entity collection, since X omits empty ones entirely', () => {
            expect(bare.entities).toEqual({ hashtags: [], mentions: [], urls: [], media: [] });
        });

        it('defaults counters to 0', () => {
            expect(bare.metrics.likes).toBe(0);
            expect(bare.metrics.retweets).toBe(0);
        });

        it('maps the undetermined language to null', () => {
            const tweet = decodeOk({
                rest_id: '1',
                core: { user_results: { result: { rest_id: '2', core: { name: 'A', screen_name: 'a' } } } },
                legacy: { created_at: 'Wed Mar 05 11:22:33 +0000 2025', lang: 'und' },
            });

            expect(tweet.lang).toBeNull();
        });
    });

    describe('source', () => {
        it('strips the anchor tag X wraps the client name in', () => {
            const raw = {
                ...(tweet20() as Record<string, unknown>),
                source: '<a href="https://mobile.twitter.com" rel="nofollow">Twitter Web App</a>',
            };

            expect(decodeOk(raw).source).toBe('Twitter Web App');
        });
    });

    describe('nodes that are not tweets', () => {
        it('unwraps TweetWithVisibilityResults', () => {
            const tweet = decodeOk({ __typename: 'TweetWithVisibilityResults', tweet: tweet20() });

            expect(tweet.id).toBe('20');
        });

        it('skips tombstones and unavailable tweets with a reason', () => {
            expect(decodeTweetResult({ __typename: 'TweetTombstone' })).toMatchObject({
                ok: false,
                reason: 'tombstone',
            });
            expect(decodeTweetResult({ __typename: 'TweetUnavailable' })).toMatchObject({
                ok: false,
                reason: 'unavailable',
            });
        });

        it('reports malformed payloads instead of throwing', () => {
            expect(decodeTweetResult(null)).toMatchObject({ ok: false, reason: 'malformed' });
            expect(decodeTweetResult({ rest_id: '1' })).toMatchObject({ ok: false, reason: 'malformed' });
            expect(
                decodeTweetResult({
                    rest_id: '1',
                    core: { user_results: { result: { rest_id: '2', core: { name: 'A', screen_name: 'a' } } } },
                    legacy: { created_at: 'not a date' },
                }),
            ).toMatchObject({ ok: false, reason: 'malformed' });
        });
    });
});
