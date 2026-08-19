import { z } from 'zod';
import type { TweetEntity } from '../../domain/types.js';
import { decodeTweetResult, type TweetSkipReason } from './tweet.js';
import type { UserUnavailableReason } from './user.js';

/**
 * Decoder for X's timeline "instruction" payloads, verified 2026-08-19 against a
 * captured `UserTweets` page.
 *
 * The shape is a list of instructions, each carrying entries of different kinds.
 * Two of them are easy to get wrong:
 *
 * - `profile-conversation-*` entries are *modules* holding several tweets under
 *   `content.items[]`. A decoder that only reads `tweet-*` entries silently drops
 *   them — in the captured page that is 4 entries worth 6 tweets out of 20.
 * - `TimelinePinEntry` is delivered as its own instruction and repeats the pinned
 *   tweet, which also appears in its chronological position. Emitting it produces
 *   a duplicate, so the whole instruction is skipped.
 *
 * Note that `data.user.result` here carries only `{ __typename, timeline }` — the
 * timeline surface returns no profile fields at all. Author details come from the
 * `UserByScreenName` call that resolved the id in the first place, and so does the
 * `protected` flag; this decoder only reports the account states that are visible
 * from here.
 */

const CursorSchema = z.object({
    entryType: z.literal('TimelineTimelineCursor'),
    cursorType: z.string(),
    value: z.string(),
});

const EntrySchema = z.object({
    entryId: z.string(),
    content: z.unknown(),
});

const InstructionSchema = z.object({
    type: z.string(),
    entries: z.array(EntrySchema).optional(),
});

const TimelineEnvelopeSchema = z.object({
    data: z
        .object({
            user: z.object({ result: z.unknown() }).optional(),
        })
        .optional(),
    errors: z.array(z.object({ message: z.string() })).optional(),
});

export type PageSkipReason = TweetSkipReason | 'promoted';

export interface DecodedPage {
    readonly tweets: TweetEntity[];
    /** Cursor for the next (older) page. `null` means the timeline ended. */
    readonly cursor: string | null;
    /** How many entries were dropped, by cause. Feeds the run summary. */
    readonly skipped: Readonly<Partial<Record<PageSkipReason, number>>>;
}

export type DecodedTimelineResult =
    | { readonly ok: true; readonly page: DecodedPage }
    | { readonly ok: false; readonly reason: UserUnavailableReason; readonly message: string };

/** Decodes a whole `UserTweets` / `UserTweetsAndReplies` response body. */
export function decodeUserTimeline(body: unknown): DecodedTimelineResult {
    const envelope = TimelineEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
        return { ok: false, reason: 'unavailable', message: 'unrecognised response envelope' };
    }

    const userNode = envelope.data.data?.user?.result;
    if (userNode === undefined) {
        const message = envelope.data.errors?.[0]?.message ?? 'user not found';
        return { ok: false, reason: 'not_found', message };
    }

    const unavailable = readUnavailable(userNode);
    if (unavailable !== null) return unavailable;

    const instructions = readInstructions(userNode);
    return { ok: true, page: decodeInstructions(instructions) };
}

/** The timeline surface still reports a suspended or withheld account inline. */
function readUnavailable(userNode: unknown): DecodedTimelineResult | null {
    const node = asRecord(userNode);
    if (node === null) {
        return { ok: false, reason: 'unavailable', message: 'user node is not an object' };
    }
    if (node['__typename'] !== 'UserUnavailable') return null;

    const reason = typeof node['reason'] === 'string' ? node['reason'] : '';
    const message = typeof node['message'] === 'string' ? node['message'] : `user unavailable: ${reason}`;

    if (reason === 'Suspended') return { ok: false, reason: 'suspended', message };
    if (reason === 'Protected') return { ok: false, reason: 'protected', message };
    return { ok: false, reason: 'unavailable', message };
}

function readInstructions(userNode: unknown): unknown[] {
    const path = ['timeline', 'timeline', 'instructions'];
    let current: unknown = userNode;
    for (const key of path) {
        if (current == null || typeof current !== 'object') return [];
        current = (current as Record<string, unknown>)[key];
    }
    return Array.isArray(current) ? current : [];
}

function decodeInstructions(instructions: unknown[]): DecodedPage {
    const tweets: TweetEntity[] = [];
    const skipped: Partial<Record<PageSkipReason, number>> = {};
    let cursor: string | null = null;

    const drop = (reason: PageSkipReason): void => {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
    };

    for (const raw of instructions) {
        const instruction = InstructionSchema.safeParse(raw);
        // TimelinePinEntry is deliberately not handled: the pinned tweet also
        // appears in chronological order, so emitting it would duplicate it.
        if (!instruction.success || instruction.data.type !== 'TimelineAddEntries') continue;

        for (const entry of instruction.data.entries ?? []) {
            const bottom = readBottomCursor(entry.content);
            if (bottom !== null) {
                cursor = bottom;
                continue;
            }

            if (entry.entryId.startsWith('promoted-')) {
                drop('promoted');
                continue;
            }

            for (const node of readTweetNodes(entry.content)) {
                if (isPromoted(node.itemContent)) {
                    drop('promoted');
                    continue;
                }

                const decoded = decodeTweetResult(node.result);
                if (decoded.ok) tweets.push(decoded.tweet);
                else drop(decoded.reason);
            }
        }
    }

    return { tweets, cursor, skipped };
}

/** Only the Bottom cursor advances a chronological timeline; Top pages backwards. */
function readBottomCursor(content: unknown): string | null {
    const parsed = CursorSchema.safeParse(content);
    if (!parsed.success) return null;
    return parsed.data.cursorType === 'Bottom' ? parsed.data.value : null;
}

interface TweetNode {
    readonly itemContent: unknown;
    readonly result: unknown;
}

/**
 * Yields the tweet nodes an entry holds: one for a plain item, several for a
 * conversation module.
 */
function readTweetNodes(content: unknown): TweetNode[] {
    const node = asRecord(content);
    if (node === null) return [];

    switch (node['entryType']) {
        case 'TimelineTimelineItem': {
            const tweet = readItemContent(node['itemContent']);
            return tweet === null ? [] : [tweet];
        }
        case 'TimelineTimelineModule': {
            const items = Array.isArray(node['items']) ? node['items'] : [];
            return items.flatMap((item) => {
                const inner = asRecord(asRecord(item)?.['item']);
                const tweet = inner === null ? null : readItemContent(inner['itemContent']);
                return tweet === null ? [] : [tweet];
            });
        }
        default:
            return [];
    }
}

function readItemContent(itemContent: unknown): TweetNode | null {
    const record = asRecord(itemContent);
    if (record === null || record['__typename'] !== 'TimelineTweet') return null;

    const results = asRecord(record['tweet_results']);
    if (results === null || !('result' in results)) return null;

    return { itemContent: record, result: results['result'] };
}

/** Ads carry promotion metadata; they are not results the caller asked for. */
function isPromoted(itemContent: unknown): boolean {
    return asRecord(itemContent)?.['promotedMetadata'] != null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
