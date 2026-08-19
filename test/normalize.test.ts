import { describe, expect, it } from 'vitest';
import { normalize, tweetUrl } from '../src/domain/normalize.js';
import type { DatasetItem } from '../src/domain/types.js';
import { fixedClock, makeTweet } from './helpers.js';

/** Assessment §5 is a contract: every key present, nothing extra, nothing `undefined`. */
const EXPECTED_KEYS = {
    root: [
        'id', 'url', 'text', 'lang', 'createdAt', 'conversationId', 'isReply', 'isRetweet',
        'isQuote', 'inReplyToId', 'quotedTweetId', 'author', 'metrics', 'entities', 'source',
        'scrapedAt',
    ],
    author: ['id', 'username', 'name', 'verified', 'followers', 'following'],
    metrics: ['likes', 'retweets', 'replies', 'quotes', 'bookmarks', 'views'],
    entities: ['hashtags', 'mentions', 'urls', 'media'],
} as const;

function assertExactShape(item: DatasetItem): void {
    expect(Object.keys(item).sort()).toEqual([...EXPECTED_KEYS.root].sort());
    expect(Object.keys(item.author).sort()).toEqual([...EXPECTED_KEYS.author].sort());
    expect(Object.keys(item.metrics).sort()).toEqual([...EXPECTED_KEYS.metrics].sort());
    expect(Object.keys(item.entities).sort()).toEqual([...EXPECTED_KEYS.entities].sort());
}

describe('normalize', () => {
    it('produces exactly the §5 shape, with no extra or missing keys', () => {
        assertExactShape(normalize(makeTweet(), fixedClock));
    });

    it('never emits undefined: absent values are null', () => {
        const item = normalize(
            makeTweet({ lang: null, conversationId: null, source: null }),
            fixedClock,
        );
        // JSON.stringify drops undefined values, so a round-trip proves none leaked.
        expect(JSON.parse(JSON.stringify(item))).toEqual(item);
        expect(item.lang).toBeNull();
        expect(item.source).toBeNull();
        expect(item.metrics.bookmarks).toBeNull();
    });

    it('keeps the id as a string, without losing precision on 19-digit ids', () => {
        const id = '1899999999999999999';
        const item = normalize(makeTweet({ id }), fixedClock);

        expect(typeof item.id).toBe('string');
        expect(item.id).toBe(id);
        // The regression this guards against: Number(id) rounds to ...0000000000.
        expect(String(Number(id))).not.toBe(id);
    });

    it('renders timestamps as ISO-8601 UTC', () => {
        const item = normalize(
            makeTweet({ createdAt: new Date('2026-03-04T11:22:33.000Z') }),
            fixedClock,
        );

        expect(item.createdAt).toBe('2026-03-04T11:22:33.000Z');
        expect(item.scrapedAt).toBe('2026-08-19T12:00:00.000Z');
    });

    it('composes the permalink from the author handle and the tweet id', () => {
        const item = normalize(makeTweet(), fixedClock);

        expect(item.url).toBe('https://x.com/apify/status/1899999999999999999');
        expect(tweetUrl('someone', '42')).toBe('https://x.com/someone/status/42');
    });

    it('copies entity arrays instead of aliasing the source tweet', () => {
        const tweet = makeTweet();
        const item = normalize(tweet, fixedClock);

        expect(item.entities.hashtags).not.toBe(tweet.entities.hashtags);
        expect(item.entities.hashtags).toEqual(['buildinpublic']);
    });
});
