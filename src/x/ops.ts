import type { AuthorEntity, TweetEntity } from '../domain/types.js';
import { XRequestError, type Session, type XClient } from './client.js';
import { decodeTweetResult } from './decode/tweet.js';
import { decodeUserTimeline, type DecodedPage } from './decode/timeline.js';
import { decodeUserByScreenName, type UserUnavailableReason } from './decode/user.js';

/**
 * The three guest-reachable operations this build targets (assessment §2a).
 *
 * Verified 2026-08-19: all three answer HTTP 200 with a plain guest token and an
 * empty features map. `SearchTimeline` is not here on purpose — it answers 404
 * with an empty body to unauthenticated callers, and this build rejects search
 * input at validation rather than pretending otherwise.
 */

export const OPERATIONS = {
    userByScreenName: 'UserByScreenName',
    userTweets: 'UserTweets',
    userTweetsAndReplies: 'UserTweetsAndReplies',
    tweetResultByRestId: 'TweetResultByRestId',
} as const;

export type UnavailableResult = {
    readonly ok: false;
    readonly reason: UserUnavailableReason;
    readonly message: string;
};

export type ProfileResult =
    | { readonly ok: true; readonly author: AuthorEntity; readonly isProtected: boolean }
    | UnavailableResult;

/** Resolves a handle to the profile fields and, crucially, the numeric user id. */
export async function fetchProfile(
    client: XClient,
    session: Session,
    handle: string,
): Promise<ProfileResult> {
    const body = await client.call({
        operation: OPERATIONS.userByScreenName,
        variables: { screen_name: handle },
        session,
    });

    const decoded = decodeUserByScreenName(body);
    if (!decoded.ok) return decoded;

    return { ok: true, author: decoded.user.author, isProtected: decoded.user.isProtected };
}

export interface TimelinePageRequest {
    readonly userId: string;
    /** `null` for the first page. */
    readonly cursor: string | null;
    /**
     * Sent for completeness; X ignores it. Measured across 20/40/100/200, the
     * response is identical, so page size is not a lever we control.
     */
    readonly count: number;
    readonly includeReplies: boolean;
    /** Called when the replies timeline turns out to be closed to guests. */
    readonly onRepliesUnavailable?: (() => void) | undefined;
}

export type TimelinePageResult = { readonly ok: true; readonly page: DecodedPage } | UnavailableResult;

/**
 * One page of an author's timeline.
 *
 * `UserTweetsAndReplies` is present in X's bundle but answers **404 with an empty
 * body** to a guest token, exactly as `SearchTimeline` does — verified 2026-08-20
 * while `UserTweets` returned 200 over the identical transport. So `includeReplies`
 * degrades to the plain timeline rather than failing the target: replies that
 * appear there are still returned, standalone replies are not. The caller is told,
 * so the run summary and the logs can say so honestly.
 */
export async function fetchTimelinePage(
    client: XClient,
    session: Session,
    request: TimelinePageRequest,
): Promise<TimelinePageResult> {
    if (request.includeReplies) {
        try {
            return await callTimeline(client, session, request, OPERATIONS.userTweetsAndReplies);
        } catch (error: unknown) {
            if (!(error instanceof XRequestError) || error.status !== 404) throw error;
            request.onRepliesUnavailable?.();
        }
    }

    return callTimeline(client, session, request, OPERATIONS.userTweets);
}

async function callTimeline(
    client: XClient,
    session: Session,
    request: TimelinePageRequest,
    operation: string,
): Promise<TimelinePageResult> {
    const body = await client.call({
        operation,
        variables: {
            userId: request.userId,
            count: request.count,
            includePromotedContent: false,
            withQuickPromoteEligibilityTweetFields: false,
            withVoice: true,
            withV2Timeline: true,
            ...(request.cursor === null ? {} : { cursor: request.cursor }),
        },
        session,
    });

    return decodeUserTimeline(body);
}

export type TweetResult =
    | { readonly ok: true; readonly tweet: TweetEntity }
    | { readonly ok: false; readonly reason: string; readonly message: string };

/** Hydrates a single tweet by id. */
export async function fetchTweetById(
    client: XClient,
    session: Session,
    tweetId: string,
): Promise<TweetResult> {
    const body = await client.call({
        operation: OPERATIONS.tweetResultByRestId,
        variables: {
            tweetId,
            withCommunity: false,
            includePromotedContent: false,
            withVoice: false,
        },
        session,
    });

    const node = readTweetResultNode(body);
    if (node === undefined) {
        return { ok: false, reason: 'not_found', message: `tweet ${tweetId} returned no result` };
    }

    return decodeTweetResult(node);
}

function readTweetResultNode(body: unknown): unknown {
    if (body == null || typeof body !== 'object') return undefined;
    const data = (body as Record<string, unknown>)['data'];
    if (data == null || typeof data !== 'object') return undefined;
    const result = (data as Record<string, unknown>)['tweetResult'];
    if (result == null || typeof result !== 'object') return undefined;

    const node = (result as Record<string, unknown>)['result'];
    // An empty `tweetResult` object is how X reports a deleted or withheld tweet.
    return node === undefined || (typeof node === 'object' && node !== null && Object.keys(node).length === 0)
        ? undefined
        : node;
}
