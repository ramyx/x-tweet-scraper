import { z } from 'zod';
import type { MediaEntity, MediaKind, TweetEntity, TweetMetrics } from '../../domain/types.js';
import { decodeUserResult } from './user.js';

/**
 * Decoder for X's Tweet payload, written against responses captured 2026-08-19.
 *
 * Unlike the User object, the Tweet still carries its fields under `legacy`. What
 * bites here is absence: X omits entity keys entirely when they are empty, so
 * `entities.hashtags` simply does not exist on a tweet without hashtags. Every
 * collection is therefore defaulted, never assumed.
 */

const MediaVariantSchema = z.object({
    bitrate: z.number().optional(),
    content_type: z.string(),
    url: z.string(),
});

const MediaSchema = z.object({
    type: z.string(),
    /** For photos the image; for video/gif the poster frame. */
    media_url_https: z.string().optional(),
    /** The t.co shortlink for this attachment, appended to `full_text`. */
    url: z.string().optional(),
    video_info: z.object({ variants: z.array(MediaVariantSchema).default([]) }).optional(),
});

const UrlEntitySchema = z.object({
    url: z.string(),
    expanded_url: z.string().optional(),
});

const EntitiesSchema = z
    .object({
        hashtags: z.array(z.object({ text: z.string() })).default([]),
        user_mentions: z.array(z.object({ screen_name: z.string() })).default([]),
        urls: z.array(UrlEntitySchema).default([]),
        media: z.array(MediaSchema).default([]),
    })
    .default({});

const LegacySchema = z.object({
    id_str: z.string().optional(),
    full_text: z.string().default(''),
    created_at: z.string(),
    lang: z.string().optional(),
    conversation_id_str: z.string().optional(),
    in_reply_to_status_id_str: z.string().optional(),
    is_quote_status: z.boolean().optional(),
    quoted_status_id_str: z.string().optional(),
    favorite_count: z.number().default(0),
    retweet_count: z.number().default(0),
    reply_count: z.number().default(0),
    quote_count: z.number().default(0),
    bookmark_count: z.number().optional(),
    entities: EntitiesSchema,
    extended_entities: z.object({ media: z.array(MediaSchema).default([]) }).optional(),
    retweeted_status_result: z.object({ result: z.unknown() }).optional(),
});

const ViewsSchema = z.object({
    count: z.string().optional(),
    state: z.string().optional(),
});

const TweetSchema = z.object({
    __typename: z.string().optional(),
    rest_id: z.string(),
    core: z.object({ user_results: z.object({ result: z.unknown() }) }).optional(),
    legacy: LegacySchema,
    source: z.string().optional(),
    views: ViewsSchema.optional(),
    note_tweet: z
        .object({
            note_tweet_results: z.object({ result: z.object({ text: z.string() }) }),
        })
        .optional(),
});

type ParsedTweet = z.infer<typeof TweetSchema>;

export type TweetSkipReason = 'tombstone' | 'unavailable' | 'malformed';

export type DecodedTweetResult =
    | { readonly ok: true; readonly tweet: TweetEntity }
    | { readonly ok: false; readonly reason: TweetSkipReason; readonly message: string };

/**
 * Unwraps the result wrappers X interleaves with real tweets.
 * `TweetWithVisibilityResults` hides the tweet one level down; tombstones and
 * unavailable entries carry no tweet at all and must be skipped, not failed.
 */
function unwrap(raw: unknown): { node: unknown } | DecodedTweetResult {
    if (raw == null || typeof raw !== 'object') {
        return { ok: false, reason: 'malformed', message: 'tweet node is not an object' };
    }

    const node = raw as Record<string, unknown>;
    switch (node['__typename']) {
        case 'TweetWithVisibilityResults':
            return { node: node['tweet'] };
        case 'TweetTombstone':
            return { ok: false, reason: 'tombstone', message: 'tweet is a tombstone' };
        case 'TweetUnavailable':
            return { ok: false, reason: 'unavailable', message: 'tweet is unavailable' };
        default:
            return { node };
    }
}

export function decodeTweetResult(raw: unknown): DecodedTweetResult {
    const unwrapped = unwrap(raw);
    if ('ok' in unwrapped) return unwrapped;

    const parsed = TweetSchema.safeParse(unwrapped.node);
    if (!parsed.success) {
        return {
            ok: false,
            reason: 'malformed',
            message: parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
        };
    }

    const tweet = parsed.data;
    const authorNode = tweet.core?.user_results.result;
    const author = decodeUserResult(authorNode);
    if (!author.ok) {
        return { ok: false, reason: 'malformed', message: `author: ${author.message}` };
    }

    const createdAt = new Date(tweet.legacy.created_at);
    if (Number.isNaN(createdAt.getTime())) {
        return { ok: false, reason: 'malformed', message: `unparseable created_at` };
    }

    // A retweet wrapper's own `full_text` is the truncated "RT @user: …" string and
    // its counters are the retweeter's, so content comes from the inner tweet while
    // the wrapper still supplies identity and timestamp.
    const inner = decodeInner(tweet.legacy.retweeted_status_result?.result);
    const content = inner ?? tweet;

    return {
        ok: true,
        tweet: {
            id: tweet.rest_id,
            text: buildText(content),
            lang: normalizeLang(tweet.legacy.lang),
            createdAt,
            conversationId: tweet.legacy.conversation_id_str ?? null,
            isReply: tweet.legacy.in_reply_to_status_id_str != null,
            isRetweet: inner !== null,
            isQuote: tweet.legacy.quoted_status_id_str != null,
            inReplyToId: tweet.legacy.in_reply_to_status_id_str ?? null,
            quotedTweetId: tweet.legacy.quoted_status_id_str ?? null,
            author: author.user.author,
            metrics: readMetrics(content),
            entities: readEntities(content),
            source: stripSourceTag(tweet.source),
        },
    };
}

function decodeInner(raw: unknown): ParsedTweet | null {
    if (raw == null) return null;
    const unwrapped = unwrap(raw);
    if ('ok' in unwrapped) return null;
    const parsed = TweetSchema.safeParse(unwrapped.node);
    return parsed.success ? parsed.data : null;
}

/** `und` means X could not determine a language, which is not a language. */
function normalizeLang(lang: string | undefined): string | null {
    return lang == null || lang === 'und' ? null : lang;
}

function readMetrics(tweet: ParsedTweet): TweetMetrics {
    return {
        likes: tweet.legacy.favorite_count,
        retweets: tweet.legacy.retweet_count,
        replies: tweet.legacy.reply_count,
        quotes: tweet.legacy.quote_count,
        bookmarks: tweet.legacy.bookmark_count ?? null,
        views: readViews(tweet.views),
    };
}

/** X reports views as a *string*, and only when it says the counter is enabled. */
function readViews(views: z.infer<typeof ViewsSchema> | undefined): number | null {
    if (views?.count == null) return null;
    if (views.state != null && views.state !== 'EnabledWithCount') return null;
    const parsed = Number(views.count);
    return Number.isFinite(parsed) ? parsed : null;
}

function readEntities(tweet: ParsedTweet): TweetEntity['entities'] {
    const { entities, extended_entities } = tweet.legacy;
    // `extended_entities` carries every attachment; `entities.media` is truncated
    // to the first one, so prefer the former when present.
    const media = extended_entities?.media ?? entities.media;

    return {
        hashtags: entities.hashtags.map((h) => h.text),
        mentions: entities.user_mentions.map((m) => m.screen_name),
        urls: dedupe(entities.urls.map((u) => u.expanded_url ?? u.url)),
        media: media.flatMap(decodeMedia),
    };
}

function decodeMedia(media: z.infer<typeof MediaSchema>): MediaEntity[] {
    const kind = toMediaKind(media.type);
    if (kind === null) return [];

    if (kind === 'photo') {
        const url = media.media_url_https;
        return url == null ? [] : [{ type: kind, url, thumbnail: null }];
    }

    const url = bestVideoVariant(media.video_info?.variants ?? []);
    if (url == null) return [];
    return [{ type: kind, url, thumbnail: media.media_url_https ?? null }];
}

function toMediaKind(type: string): MediaKind | null {
    return type === 'photo' || type === 'video' || type === 'animated_gif' ? type : null;
}

/**
 * Variants mix HLS playlists (no bitrate) with progressive mp4s. Only the mp4s are
 * directly usable, so pick the highest-bitrate one.
 */
function bestVideoVariant(variants: z.infer<typeof MediaVariantSchema>[]): string | null {
    const mp4s = variants.filter((v) => v.content_type === 'video/mp4');
    if (mp4s.length === 0) return null;

    return mp4s.reduce((best, v) => ((v.bitrate ?? 0) > (best.bitrate ?? 0) ? v : best)).url;
}

/**
 * The text clients see: long-form when present, t.co links replaced with their
 * destinations, HTML entities decoded, and the trailing media shortlink removed.
 */
function buildText(tweet: ParsedTweet): string {
    let text = tweet.note_tweet?.note_tweet_results.result.text ?? tweet.legacy.full_text;

    for (const url of tweet.legacy.entities.urls) {
        if (url.expanded_url != null) text = text.split(url.url).join(url.expanded_url);
    }

    const media = tweet.legacy.extended_entities?.media ?? tweet.legacy.entities.media;
    for (const attachment of media) {
        if (attachment.url != null) text = text.split(attachment.url).join('');
    }

    return unescapeHtml(text).trim();
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&nbsp;': ' ',
};

function unescapeHtml(text: string): string {
    return text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => HTML_ENTITIES[m] ?? m);
}

/** `<a href="…">Twitter Web App</a>` → `Twitter Web App`. */
function stripSourceTag(source: string | undefined): string | null {
    if (source == null) return null;
    const label = source.replace(/<[^>]*>/g, '').trim();
    return label.length > 0 ? label : null;
}

function dedupe(values: string[]): string[] {
    return [...new Set(values)];
}
