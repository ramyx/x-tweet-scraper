/**
 * Domain types. This module is pure: it must never import from the transport,
 * infrastructure or Apify layers, which is what keeps the filter, normalizer and
 * quota tests fast and network-free.
 */

// ---------------------------------------------------------------------------
// Output contract (assessment §5)
// ---------------------------------------------------------------------------

/**
 * The exact shape of every dataset item. Clients build on this contract, so it is
 * part of the grade: missing values are `null`, never omitted and never `undefined`.
 */
export interface DatasetItem {
    /** Tweet id. A string, never a JS number — 19-digit ids lose precision as floats. */
    readonly id: string;
    /** `https://x.com/<username>/status/<id>` */
    readonly url: string;
    /** Full text, HTML-unescaped, with t.co links expanded. */
    readonly text: string;
    /** ISO-639-1. X's `und` ("undetermined") is mapped to `null`. */
    readonly lang: string | null;
    /** ISO-8601 UTC. */
    readonly createdAt: string;
    readonly conversationId: string | null;
    readonly isReply: boolean;
    readonly isRetweet: boolean;
    readonly isQuote: boolean;
    readonly inReplyToId: string | null;
    readonly quotedTweetId: string | null;
    readonly author: DatasetAuthor;
    readonly metrics: TweetMetrics;
    readonly entities: TweetEntities;
    /** Client app the tweet was posted from. Often absent on guest responses. */
    readonly source: string | null;
    /** ISO-8601 UTC of extraction. */
    readonly scrapedAt: string;
}

export interface DatasetAuthor {
    readonly id: string;
    /** Handle, without `@`. */
    readonly username: string;
    readonly name: string;
    /** True for any current X verification program (Blue, legacy or identity). */
    readonly verified: boolean;
    readonly followers: number;
    readonly following: number;
}

export interface TweetMetrics {
    readonly likes: number;
    readonly retweets: number;
    readonly replies: number;
    readonly quotes: number;
    /** `null` when the surface does not expose it. */
    readonly bookmarks: number | null;
    /** `null` unless X reports `EnabledWithCount`. */
    readonly views: number | null;
}

export interface TweetEntities {
    /** Without `#`, as returned by X (case preserved). */
    readonly hashtags: string[];
    /** Handles, without `@`. */
    readonly mentions: string[];
    /** Expanded urls, deduped, order preserved. */
    readonly urls: string[];
    readonly media: MediaEntity[];
}

export type MediaKind = 'photo' | 'video' | 'animated_gif';

export interface MediaEntity {
    readonly type: MediaKind;
    /** Best available variant: highest-bitrate mp4 for video, full image for photo. */
    readonly url: string;
    /** Poster frame for video/gif; `null` for photos. */
    readonly thumbnail: string | null;
}

// ---------------------------------------------------------------------------
// Internal representation
// ---------------------------------------------------------------------------

/**
 * A decoded tweet, before projection to the output contract.
 *
 * It differs from {@link DatasetItem} in exactly two ways, both deliberate:
 * `createdAt` is a real `Date` (filters compare it, and the pager uses it to stop
 * early once a timeline runs past the `since` bound), and the derived `url` and
 * `scrapedAt` fields do not exist yet.
 */
export interface TweetEntity {
    readonly id: string;
    readonly text: string;
    readonly lang: string | null;
    readonly createdAt: Date;
    readonly conversationId: string | null;
    readonly isReply: boolean;
    readonly isRetweet: boolean;
    readonly isQuote: boolean;
    readonly inReplyToId: string | null;
    readonly quotedTweetId: string | null;
    readonly author: AuthorEntity;
    readonly metrics: TweetMetrics;
    readonly entities: TweetEntities;
    readonly source: string | null;
}

export type AuthorEntity = DatasetAuthor;

// ---------------------------------------------------------------------------
// Filters (assessment §4)
// ---------------------------------------------------------------------------

export type MediaFilter = 'any' | 'text_only' | 'images' | 'video' | 'links';
export type SortBy = 'latest' | 'top';

/**
 * The subset of the actor input that constrains results. An absent field means
 * "no constraint"; present fields combine with AND.
 *
 * Deliberately decoupled from the input schema: the app layer maps validated
 * input onto this, so the filter logic never sees a raw user payload.
 */
export interface Filters {
    /** All listed hashtags must be present. Compared case-insensitively, without `#`. */
    readonly hashtags: string[];
    /** Inclusive lower bound on creation time. */
    readonly since: Date | null;
    /** Inclusive upper bound on creation time. */
    readonly until: Date | null;
    readonly language: string | null;
    readonly minLikes: number | null;
    readonly minRetweets: number | null;
    readonly minReplies: number | null;
    readonly onlyVerified: boolean;
    readonly mediaType: MediaFilter;
    readonly includeReplies: boolean;
    readonly includeRetweets: boolean;
}

/** Which constraint rejected a tweet. Feeds the run summary's breakdown. */
export type FilterReason = keyof Filters;

export type FilterResult = { readonly kept: true } | { readonly kept: false; readonly rejectedBy: FilterReason };

// ---------------------------------------------------------------------------
// Entitlement (assessment §6)
// ---------------------------------------------------------------------------

export type Tier = 'free' | 'paid';

/**
 * The answer to "how many results may this run emit?", resolved from a server we
 * control. Nothing derived from actor input may ever produce one of these.
 */
export interface Entitlement {
    readonly tier: Tier;
    /** Hard ceiling for the run. `Infinity` for paid: the request itself is the limit. */
    readonly cap: number;
    /** How the answer was reached. `fail-closed` means the check did not succeed. */
    readonly source: 'service' | 'fail-closed';
    /** Machine-readable explanation, surfaced in the run summary. */
    readonly reason: string | null;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Injected so `scrapedAt` is deterministic under test. */
export interface Clock {
    now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * Where accepted results go. Deliberately a dumb pipe with no policy of its own:
 * every decision about *whether* an item may be emitted belongs to the quota guard.
 */
export interface ResultSink {
    push(item: DatasetItem): Promise<void>;
}
