import type {
    Clock,
    DatasetItem,
    Entitlement,
    Filters,
    MediaEntity,
    MediaKind,
    ResultSink,
    TweetEntity,
} from '../src/domain/types.js';
import { NO_CONSTRAINTS } from '../src/domain/filters.js';
import { normalize } from '../src/domain/normalize.js';
import { FREE_TIER_CAP } from '../src/domain/quota.js';

export const fixedClock: Clock = { now: () => new Date('2026-08-19T12:00:00.000Z') };

/** A plain, unfiltered-by-default tweet. Override only what a test is about. */
export function makeTweet(overrides: Partial<TweetEntity> = {}): TweetEntity {
    return {
        id: '1899999999999999999',
        text: 'hello world',
        lang: 'en',
        createdAt: new Date('2026-03-04T11:22:33.000Z'),
        conversationId: '1899999999999999999',
        isReply: false,
        isRetweet: false,
        isQuote: false,
        inReplyToId: null,
        quotedTweetId: null,
        author: {
            id: '783214',
            username: 'apify',
            name: 'Apify',
            verified: true,
            followers: 1234,
            following: 56,
        },
        metrics: { likes: 10, retweets: 2, replies: 1, quotes: 0, bookmarks: null, views: 900 },
        entities: { hashtags: ['buildinpublic'], mentions: ['x'], urls: [], media: [] },
        source: 'Twitter Web App',
        ...overrides,
    };
}

export function makeFilters(overrides: Partial<Filters> = {}): Filters {
    return { ...NO_CONSTRAINTS, ...overrides };
}

export function makeMedia(type: MediaKind): MediaEntity {
    return {
        type,
        url: `https://pbs.twimg.com/media/example.${type === 'photo' ? 'jpg' : 'mp4'}`,
        thumbnail: type === 'photo' ? null : 'https://pbs.twimg.com/media/thumb.jpg',
    };
}

// ---------------------------------------------------------------------------
// Quota helpers
// ---------------------------------------------------------------------------

/** A sink that records instead of writing anywhere. */
export class RecordingSink implements ResultSink {
    readonly items: DatasetItem[] = [];

    async push(item: DatasetItem): Promise<void> {
        this.items.push(item);
    }
}

export const PAID: Entitlement = {
    tier: 'paid',
    cap: Number.POSITIVE_INFINITY,
    source: 'service',
    reason: null,
};

export const FREE: Entitlement = {
    tier: 'free',
    cap: FREE_TIER_CAP,
    source: 'service',
    reason: 'free_tier',
};

/** What the resolver must return whenever entitlement cannot be verified. */
export const FAIL_CLOSED: Entitlement = {
    tier: 'free',
    cap: FREE_TIER_CAP,
    source: 'fail-closed',
    reason: 'entitlement_unavailable',
};

/** `count` distinct dataset items, ids ascending so duplicates are visible. */
export function makeItems(count: number): DatasetItem[] {
    return Array.from({ length: count }, (_, i) =>
        normalize(makeTweet({ id: String(1900000000000000000n + BigInt(i)) }), fixedClock),
    );
}
