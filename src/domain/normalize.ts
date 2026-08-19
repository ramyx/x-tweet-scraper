import type { Clock, DatasetItem, TweetEntity } from './types.js';
import { systemClock } from './types.js';

/**
 * Projection from the internal entity to the output contract (assessment §5).
 *
 * The heavy lifting — unwrapping X's payload variants, expanding t.co links,
 * picking media variants — happens in the decoder that produces a `TweetEntity`.
 * By the time a tweet reaches this function it is already clean, so this stays a
 * single, auditable place that guarantees the shape clients build on:
 * every key present, missing values `null`, ids as strings, timestamps ISO-8601 UTC.
 */
export function normalize(tweet: TweetEntity, clock: Clock = systemClock): DatasetItem {
    return {
        id: tweet.id,
        url: tweetUrl(tweet.author.username, tweet.id),
        text: tweet.text,
        lang: tweet.lang,
        createdAt: tweet.createdAt.toISOString(),
        conversationId: tweet.conversationId,
        isReply: tweet.isReply,
        isRetweet: tweet.isRetweet,
        isQuote: tweet.isQuote,
        inReplyToId: tweet.inReplyToId,
        quotedTweetId: tweet.quotedTweetId,
        author: {
            id: tweet.author.id,
            username: tweet.author.username,
            name: tweet.author.name,
            verified: tweet.author.verified,
            followers: tweet.author.followers,
            following: tweet.author.following,
        },
        metrics: {
            likes: tweet.metrics.likes,
            retweets: tweet.metrics.retweets,
            replies: tweet.metrics.replies,
            quotes: tweet.metrics.quotes,
            bookmarks: tweet.metrics.bookmarks,
            views: tweet.metrics.views,
        },
        entities: {
            hashtags: [...tweet.entities.hashtags],
            mentions: [...tweet.entities.mentions],
            urls: [...tweet.entities.urls],
            media: tweet.entities.media.map((m) => ({
                type: m.type,
                url: m.url,
                thumbnail: m.thumbnail,
            })),
        },
        source: tweet.source,
        scrapedAt: clock.now().toISOString(),
    };
}

/** Canonical permalink. X redirects the legacy twitter.com host here anyway. */
export function tweetUrl(username: string, id: string): string {
    return `https://x.com/${username}/status/${id}`;
}
