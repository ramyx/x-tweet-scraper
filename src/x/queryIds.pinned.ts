/**
 * Query ids captured from X's web bundles on **2026-08-19**.
 *
 * These are a *fallback*, not a source of truth. X regenerates them on every web
 * deploy — roughly daily — so a build that hardcodes them works today and is dead
 * next week. The registry reads the live values from X's own bundles and only
 * falls back here when that fails, which keeps the actor running on a bad day
 * instead of failing shut.
 */
export const PINNED_QUERY_IDS: Readonly<Record<string, string>> = {
    UserByScreenName: 'Gb-d6r0vxPOADdG62OEBpQ',
    UserTweets: 'SXVCYB8XHSS25nzIljNtZA',
    UserTweetsAndReplies: 'qUpkZU6eN8MbtQb7rC_pYg',
    TweetResultByRestId: 'GZsN2Pc4knAoit6pXa4HSA',
};

export const PINNED_CAPTURED_AT = '2026-08-19';
