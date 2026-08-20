import { applyFilters, isBeforeWindow } from '../domain/filters.js';
import { normalize } from '../domain/normalize.js';
import type { QuotaGuard } from '../domain/quota.js';
import type { Clock, Filters, TweetEntity } from '../domain/types.js';
import { systemClock } from '../domain/types.js';
import type { Session, XClient } from '../x/client.js';
import { fetchProfile, fetchTimelinePage, fetchTweetById } from '../x/ops.js';
import type { ActorInput } from './input.js';
import { SeenSet, type RunState } from './state.js';
import type { SummaryBuilder, TargetStatus } from './summary.js';

/**
 * Orchestration: plan targets, page through them, filter, normalize, offer.
 *
 * The guard governs the loop rather than trimming its output. `guard.remaining()`
 * is consulted *before* each page request, so a capped run stops asking X for data
 * it could never emit — which is the difference §6 draws between enforcing at the
 * emit point and clamping `maxResults` up front.
 */

export interface RunContext {
    readonly client: XClient;
    readonly guard: QuotaGuard;
    readonly input: ActorInput;
    readonly filters: Filters;
    readonly state: RunState;
    readonly summary: SummaryBuilder;
    readonly sessionFor: (target: string) => Session;
    readonly clock?: Clock;
    readonly log?: (message: string, data?: Record<string, unknown>) => void;
    readonly persist?: () => Promise<void>;
}

/**
 * Sent for completeness only: X ignores `count`. What it returns depends on the
 * account — a busy author may come back with ~99 entries and **no cursor at all**,
 * which is the ceiling of this surface for guests.
 */
const PAGE_SIZE = 20;
const MAX_PAGES_PER_AUTHOR = 200;

export async function runScrape(context: RunContext): Promise<void> {
    const log = context.log ?? (() => {});
    const clock = context.clock ?? systemClock;
    const seen = new SeenSet(context.state.seenIds);

    const emit = async (tweet: TweetEntity): Promise<boolean> => {
        if (!seen.add(tweet.id)) return true;

        const verdict = applyFilters(tweet, context.filters);
        if (!verdict.kept) {
            context.summary.countFiltered(verdict.rejectedBy);
            return true;
        }

        return context.guard.offer(normalize(tweet, clock));
    };

    for (const tweetId of context.input.tweetIds) {
        if (context.guard.exhausted()) break;
        await hydrateTweet(context, tweetId, emit, log);
    }

    for (const handle of context.input.fromUsers) {
        if (context.guard.exhausted()) break;
        if (context.state.doneTargets.includes(handle)) continue;

        await scrapeAuthor(context, handle, seen, emit, log);

        context.state.doneTargets.push(handle);
        context.state.seenIds = seen.toArray();
        context.state.pushed = context.guard.stats().pushed;
        await context.persist?.();
    }
}

async function hydrateTweet(
    context: RunContext,
    tweetId: string,
    emit: (tweet: TweetEntity) => Promise<boolean>,
    log: (message: string, data?: Record<string, unknown>) => void,
): Promise<void> {
    const session = context.sessionFor(`tweet-${tweetId}`);

    try {
        const result = await fetchTweetById(context.client, session, tweetId);
        if (!result.ok) {
            context.summary.recordTarget(`tweet:${tweetId}`, {
                pages: 1,
                fetched: 0,
                kept: 0,
                status: 'unavailable',
                message: result.message,
            });
            log('target skipped', { tweetId, reason: result.reason });
            return;
        }

        context.summary.countFetched(1);
        const kept = await emit(result.tweet);
        context.summary.recordTarget(`tweet:${tweetId}`, {
            pages: 1,
            fetched: 1,
            kept: kept ? 1 : 0,
            status: 'ok',
        });
    } catch (error: unknown) {
        context.summary.countError('tweet_fetch');
        context.summary.recordTarget(`tweet:${tweetId}`, {
            pages: 0,
            fetched: 0,
            kept: 0,
            status: 'error',
            message: String(error),
        });
        log('tweet failed', { tweetId, error: String(error) });
    }
}

async function scrapeAuthor(
    context: RunContext,
    handle: string,
    seen: SeenSet,
    emit: (tweet: TweetEntity) => Promise<boolean>,
    log: (message: string, data?: Record<string, unknown>) => void,
): Promise<void> {
    const session = context.sessionFor(handle);
    const record = (status: TargetStatus, parts: { pages: number; fetched: number; kept: number; message?: string }) =>
        context.summary.recordTarget(handle, { status, ...parts });

    let profile;
    try {
        profile = await fetchProfile(context.client, session, handle);
    } catch (error: unknown) {
        context.summary.countError('profile_fetch');
        record('error', { pages: 0, fetched: 0, kept: 0, message: String(error) });
        return;
    }

    if (!profile.ok) {
        record(profile.reason as TargetStatus, { pages: 0, fetched: 0, kept: 0, message: profile.message });
        log('target skipped', { handle, reason: profile.reason });
        return;
    }
    if (profile.isProtected) {
        record('protected', { pages: 0, fetched: 0, kept: 0, message: 'account is protected' });
        log('target skipped', { handle, reason: 'protected' });
        return;
    }

    let cursor = context.state.cursors[handle] ?? null;
    let repliesDegraded = false;
    let pages = 0;
    let fetched = 0;
    let kept = 0;

    while (!context.guard.exhausted() && pages < MAX_PAGES_PER_AUTHOR) {
        let page;
        try {
            page = await fetchTimelinePage(context.client, session, {
                userId: profile.author.id,
                cursor,
                count: PAGE_SIZE,
                includeReplies: context.input.includeReplies,
                onRepliesUnavailable: () => {
                    if (repliesDegraded) return;
                    repliesDegraded = true;
                    context.summary.countError('replies_timeline_unavailable');
                    log('includeReplies degraded: the replies timeline is closed to guests, using the main timeline', { handle });
                },
            });
        } catch (error: unknown) {
            context.summary.countError('timeline_fetch');
            record('error', { pages, fetched, kept, message: String(error) });
            return;
        }

        if (!page.ok) {
            record(page.reason as TargetStatus, { pages, fetched, kept, message: page.message });
            return;
        }

        pages += 1;
        const { tweets, cursor: next, skipped } = page.page;
        context.summary.countSkipped(skipped);
        context.summary.countFetched(tweets.length);
        fetched += tweets.length;

        const before = context.guard.stats().pushed;
        let ranPastWindow = false;

        for (const tweet of tweets) {
            // Timelines are newest-first, so the first tweet older than `since`
            // means every remaining page is older too.
            if (isBeforeWindow(tweet, context.filters)) {
                ranPastWindow = true;
                break;
            }
            if (!(await emit(tweet))) break;
        }

        kept += context.guard.stats().pushed - before;
        context.state.cursors[handle] = next;
        context.state.seenIds = seen.toArray();
        context.state.pushed = context.guard.stats().pushed;

        log('page', { handle, page: pages, entries: tweets.length, kept, remaining: context.guard.remaining() });

        if (ranPastWindow) {
            log('stopped early: timeline ran past the requested window', { handle });
            break;
        }
        // Three termination guards: no cursor, a repeated cursor, or a page that
        // produced nothing new. X returns a stable cursor with an empty page at the
        // end of a timeline, and a naive loop spins on it forever.
        if (next === null || next === cursor || tweets.length === 0) break;

        cursor = next;
        await context.persist?.();
    }

    record('ok', { pages, fetched, kept });
}
