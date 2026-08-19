import type { FilterReason, FilterResult, Filters, TweetEntity } from './types.js';

/**
 * Post-filters from assessment §4. An unset filter means "no constraint" and all
 * set filters combine with AND.
 *
 * Pure by design: no IO, no clock, no logging. That is what lets the whole matrix
 * be covered by fast table-driven tests.
 */

interface Rule {
    /** Reported as `rejectedBy`, and aggregated into the run summary's breakdown. */
    readonly reason: FilterReason;
    /** `true` keeps the tweet. */
    test(tweet: TweetEntity, filters: Filters): boolean;
}

/**
 * Ordered cheapest-and-most-discarding first. Retweets and replies are excluded by
 * default, so they typically remove the most candidates for the least work.
 */
const RULES: readonly Rule[] = [
    {
        reason: 'includeRetweets',
        test: (t, f) => f.includeRetweets || !t.isRetweet,
    },
    {
        reason: 'includeReplies',
        test: (t, f) => f.includeReplies || !t.isReply,
    },
    {
        reason: 'since',
        test: (t, f) => f.since === null || t.createdAt.getTime() >= f.since.getTime(),
    },
    {
        reason: 'until',
        test: (t, f) => f.until === null || t.createdAt.getTime() <= f.until.getTime(),
    },
    {
        reason: 'language',
        test: (t, f) => f.language === null || t.lang === f.language,
    },
    {
        reason: 'minLikes',
        test: (t, f) => f.minLikes === null || t.metrics.likes >= f.minLikes,
    },
    {
        reason: 'minRetweets',
        test: (t, f) => f.minRetweets === null || t.metrics.retweets >= f.minRetweets,
    },
    {
        reason: 'minReplies',
        test: (t, f) => f.minReplies === null || t.metrics.replies >= f.minReplies,
    },
    {
        reason: 'onlyVerified',
        test: (t, f) => !f.onlyVerified || t.author.verified,
    },
    {
        reason: 'hashtags',
        test: (t, f) => {
            if (f.hashtags.length === 0) return true;
            const present = new Set(t.entities.hashtags.map((h) => h.toLowerCase()));
            return f.hashtags.every((wanted) => present.has(wanted.toLowerCase()));
        },
    },
    {
        reason: 'mediaType',
        test: (t, f) => matchesMediaType(t, f.mediaType),
    },
];

function matchesMediaType(tweet: TweetEntity, mediaType: Filters['mediaType']): boolean {
    const { media, urls } = tweet.entities;

    switch (mediaType) {
        case 'any':
            return true;
        case 'text_only':
            return media.length === 0 && urls.length === 0;
        case 'images':
            return media.some((m) => m.type === 'photo');
        case 'video':
            return media.some((m) => m.type === 'video' || m.type === 'animated_gif');
        case 'links':
            // `entities.urls` holds expanded external links only; media t.co links
            // are not part of it, so presence alone is the right test.
            return urls.length > 0;
    }
}

/**
 * Runs the pipeline, stopping at the first constraint that rejects the tweet so the
 * caller learns *why* it was dropped rather than just that it was.
 */
export function applyFilters(tweet: TweetEntity, filters: Filters): FilterResult {
    for (const rule of RULES) {
        if (!rule.test(tweet, filters)) {
            return { kept: false, rejectedBy: rule.reason };
        }
    }
    return { kept: true };
}

/**
 * Whether a chronological timeline has run past the requested window.
 *
 * Author timelines come newest-first, so the first tweet older than `since` means
 * every remaining page is older too: the pager stops instead of walking the whole
 * history to discard it one item at a time.
 */
export function isBeforeWindow(tweet: TweetEntity, filters: Filters): boolean {
    return filters.since !== null && tweet.createdAt.getTime() < filters.since.getTime();
}

/** All constraints off. Useful as a base in tests and for unfiltered runs. */
export const NO_CONSTRAINTS: Filters = {
    hashtags: [],
    since: null,
    until: null,
    language: null,
    minLikes: null,
    minRetweets: null,
    minReplies: null,
    onlyVerified: false,
    mediaType: 'any',
    includeReplies: false,
    includeRetweets: false,
};
