import { describe, expect, it } from 'vitest';
import { applyFilters, isBeforeWindow, NO_CONSTRAINTS } from '../src/domain/filters.js';
import type { FilterReason, Filters, TweetEntity } from '../src/domain/types.js';
import { makeFilters, makeMedia, makeTweet } from './helpers.js';

/** Asserts a tweet is dropped, and dropped for the stated reason. */
function expectRejectedBy(
    tweet: TweetEntity,
    filters: Partial<Filters>,
    reason: FilterReason,
): void {
    const result = applyFilters(tweet, makeFilters(filters));
    expect(result).toEqual({ kept: false, rejectedBy: reason });
}

function expectKept(tweet: TweetEntity, filters: Partial<Filters> = {}): void {
    expect(applyFilters(tweet, makeFilters(filters))).toEqual({ kept: true });
}

describe('applyFilters', () => {
    it('keeps a plain tweet when nothing is constrained', () => {
        expectKept(makeTweet());
    });

    describe('replies and retweets', () => {
        it('drops retweets by default (§4: default false)', () => {
            expect(NO_CONSTRAINTS.includeRetweets).toBe(false);
            expectRejectedBy(makeTweet({ isRetweet: true }), {}, 'includeRetweets');
        });

        it('drops replies by default', () => {
            expect(NO_CONSTRAINTS.includeReplies).toBe(false);
            expectRejectedBy(makeTweet({ isReply: true }), {}, 'includeReplies');
        });

        it('keeps them when explicitly included', () => {
            expectKept(makeTweet({ isRetweet: true }), { includeRetweets: true });
            expectKept(makeTweet({ isReply: true }), { includeReplies: true });
        });
    });

    describe('date window', () => {
        const at = (iso: string): TweetEntity => makeTweet({ createdAt: new Date(iso) });

        it('is inclusive on both bounds', () => {
            expectKept(at('2026-03-04T00:00:00.000Z'), { since: new Date('2026-03-04T00:00:00.000Z') });
            expectKept(at('2026-03-04T00:00:00.000Z'), { until: new Date('2026-03-04T00:00:00.000Z') });
        });

        it('drops tweets outside the window', () => {
            expectRejectedBy(at('2026-03-03T23:59:59.999Z'), { since: new Date('2026-03-04T00:00:00.000Z') }, 'since');
            expectRejectedBy(at('2026-03-04T00:00:00.001Z'), { until: new Date('2026-03-04T00:00:00.000Z') }, 'until');
        });
    });

    describe('language', () => {
        it('matches exactly', () => {
            expectKept(makeTweet({ lang: 'en' }), { language: 'en' });
            expectRejectedBy(makeTweet({ lang: 'es' }), { language: 'en' }, 'language');
        });

        it('drops tweets with an unknown language when one is required', () => {
            expectRejectedBy(makeTweet({ lang: null }), { language: 'en' }, 'language');
        });
    });

    describe('engagement floors', () => {
        const metrics = (over: Partial<TweetEntity['metrics']>): TweetEntity =>
            makeTweet({ metrics: { ...makeTweet().metrics, ...over } });

        it('is a floor, not a strict greater-than', () => {
            expectKept(metrics({ likes: 25 }), { minLikes: 25 });
        });

        it('drops tweets under each floor, reporting which one', () => {
            expectRejectedBy(metrics({ likes: 24 }), { minLikes: 25 }, 'minLikes');
            expectRejectedBy(metrics({ retweets: 1 }), { minRetweets: 2 }, 'minRetweets');
            expectRejectedBy(metrics({ replies: 0 }), { minReplies: 1 }, 'minReplies');
        });
    });

    describe('onlyVerified', () => {
        const unverified = makeTweet({ author: { ...makeTweet().author, verified: false } });

        it('drops unverified authors only when requested', () => {
            expectKept(unverified);
            expectRejectedBy(unverified, { onlyVerified: true }, 'onlyVerified');
        });
    });

    describe('hashtags', () => {
        const tagged = (...tags: string[]): TweetEntity =>
            makeTweet({ entities: { ...makeTweet().entities, hashtags: tags } });

        it('ignores case on both sides', () => {
            expectKept(tagged('BuildInPublic'), { hashtags: ['buildinpublic'] });
            expectKept(tagged('buildinpublic'), { hashtags: ['BUILDINPUBLIC'] });
        });

        it('requires every listed hashtag (AND, not OR)', () => {
            expectKept(tagged('a', 'b', 'c'), { hashtags: ['a', 'b'] });
            expectRejectedBy(tagged('a'), { hashtags: ['a', 'b'] }, 'hashtags');
        });
    });

    describe('mediaType', () => {
        const base = makeTweet().entities;
        const withMedia = (...kinds: Parameters<typeof makeMedia>[0][]): TweetEntity =>
            makeTweet({ entities: { ...base, media: kinds.map(makeMedia) } });
        const withUrls = (...urls: string[]): TweetEntity =>
            makeTweet({ entities: { ...base, urls } });
        const plain = makeTweet({ entities: { ...base, media: [], urls: [] } });

        it('any: keeps everything', () => {
            expectKept(plain, { mediaType: 'any' });
            expectKept(withMedia('video'), { mediaType: 'any' });
        });

        it('text_only: no media and no links', () => {
            expectKept(plain, { mediaType: 'text_only' });
            expectRejectedBy(withMedia('photo'), { mediaType: 'text_only' }, 'mediaType');
            expectRejectedBy(withUrls('https://example.com'), { mediaType: 'text_only' }, 'mediaType');
        });

        it('images: at least one photo', () => {
            expectKept(withMedia('photo'), { mediaType: 'images' });
            expectRejectedBy(withMedia('video'), { mediaType: 'images' }, 'mediaType');
            expectRejectedBy(plain, { mediaType: 'images' }, 'mediaType');
        });

        it('video: video or animated gif', () => {
            expectKept(withMedia('video'), { mediaType: 'video' });
            expectKept(withMedia('animated_gif'), { mediaType: 'video' });
            expectRejectedBy(withMedia('photo'), { mediaType: 'video' }, 'mediaType');
        });

        it('links: at least one expanded url', () => {
            expectKept(withUrls('https://example.com'), { mediaType: 'links' });
            expectRejectedBy(plain, { mediaType: 'links' }, 'mediaType');
        });
    });

    describe('AND semantics', () => {
        it('rejects when a single constraint fails, however many pass', () => {
            const tweet = makeTweet({
                lang: 'en',
                metrics: { ...makeTweet().metrics, likes: 100, retweets: 50 },
            });

            expectKept(tweet, { language: 'en', minLikes: 50, minRetweets: 10 });
            expectRejectedBy(
                tweet,
                { language: 'en', minLikes: 50, minRetweets: 10, minReplies: 999 },
                'minReplies',
            );
        });

        it('reports the first failing constraint in pipeline order', () => {
            // A retweet that also misses the like floor: retweets are checked first.
            expectRejectedBy(
                makeTweet({ isRetweet: true, metrics: { ...makeTweet().metrics, likes: 0 } }),
                { minLikes: 999 },
                'includeRetweets',
            );
        });
    });
});

describe('isBeforeWindow', () => {
    const since = new Date('2026-03-04T00:00:00.000Z');

    it('is false when no lower bound was requested', () => {
        expect(isBeforeWindow(makeTweet({ createdAt: new Date('2020-01-01') }), NO_CONSTRAINTS)).toBe(false);
    });

    it('signals the pager to stop once the timeline runs past `since`', () => {
        expect(isBeforeWindow(makeTweet({ createdAt: new Date('2026-03-03T23:59:59.999Z') }), makeFilters({ since }))).toBe(true);
    });

    it('does not trigger on the boundary itself, which is still in the window', () => {
        expect(isBeforeWindow(makeTweet({ createdAt: since }), makeFilters({ since }))).toBe(false);
    });
});
