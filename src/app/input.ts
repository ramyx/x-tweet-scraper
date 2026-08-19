import { z } from 'zod';
import type { Filters } from '../domain/types.js';

/**
 * Boundary validation (assessment §7). Everything the runner controls enters here
 * and nowhere else.
 *
 * The schema is `.strict()` on purpose: an undocumented extra field — `"tier"`,
 * `"cap"`, `"__proto__"` — is a hard validation error rather than something the
 * code might read later. Note also what is *absent*: nothing in this module feeds
 * the entitlement path. `maxResults` is a request; the ceiling comes from a server.
 */

/** Observed 2026-08-19. Kept verbatim so the rejection explains itself. */
export const SEARCH_UNSUPPORTED_MESSAGE =
    "searchTerms is not supported by this build. X's SearchTimeline operation is not " +
    'reachable with a guest token (observed: HTTP 404 with an empty body, while ' +
    'UserByScreenName returns 200 over the identical transport). See the README section ' +
    '"Search". Use fromUsers and/or tweetIds instead.';

const handle = z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, '').toLowerCase())
    .pipe(z.string().regex(/^[A-Za-z0-9_]{1,15}$/, 'not a valid X handle'));

const tweetId = z
    .string()
    .trim()
    .regex(/^\d{5,25}$/, 'tweet id must be a numeric string');

const hashtag = z
    .string()
    .trim()
    .transform((value) => value.replace(/^#/, '').toLowerCase())
    .pipe(z.string().min(1, 'hashtag cannot be empty'));

/** Accepts `2026-01-01` as well as a full ISO timestamp. */
const isoDate = z.string().trim().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'must be an ISO date, e.g. 2026-01-01',
});

export const InputSchema = z
    .object({
        fromUsers: z.array(handle).default([]),
        tweetIds: z.array(tweetId).default([]),
        searchTerms: z.array(z.string()).default([]),
        hashtags: z.array(hashtag).default([]),
        since: isoDate.optional(),
        until: isoDate.optional(),
        language: z.string().trim().toLowerCase().regex(/^[a-z]{2}$/, 'ISO-639-1, e.g. "en"').optional(),
        minLikes: z.number().int().nonnegative().optional(),
        minRetweets: z.number().int().nonnegative().optional(),
        minReplies: z.number().int().nonnegative().optional(),
        onlyVerified: z.boolean().default(false),
        mediaType: z.enum(['any', 'text_only', 'images', 'video', 'links']).default('any'),
        includeReplies: z.boolean().default(false),
        includeRetweets: z.boolean().default(false),
        sortBy: z.enum(['latest', 'top']).default('latest'),
        maxResults: z.number().int().positive().max(10_000).default(100),
        proxyConfiguration: z
            .object({
                useApifyProxy: z.boolean().optional(),
                apifyProxyGroups: z.array(z.string()).optional(),
                apifyProxyCountry: z.string().optional(),
                proxyUrls: z.array(z.string().url()).optional(),
            })
            .passthrough()
            .optional(),
    })
    .strict()
    .superRefine((input, ctx) => {
        if (input.searchTerms.length > 0) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['searchTerms'], message: SEARCH_UNSUPPORTED_MESSAGE });
        }
        if (input.fromUsers.length === 0 && input.tweetIds.length === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['fromUsers'],
                message: 'Provide at least one target: fromUsers or tweetIds.',
            });
        }
        if (input.since !== undefined && input.until !== undefined && Date.parse(input.since) > Date.parse(input.until)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['since'], message: '`since` must not be after `until`.' });
        }
    });

export type ActorInput = z.infer<typeof InputSchema>;

export class InputValidationError extends Error {
    constructor(readonly issues: string[]) {
        super(`Invalid input:\n  - ${issues.join('\n  - ')}`);
        this.name = 'InputValidationError';
    }
}

export function parseInput(raw: unknown): ActorInput {
    const parsed = InputSchema.safeParse(raw ?? {});
    if (parsed.success) return dedupeTargets(parsed.data);

    throw new InputValidationError(
        parsed.error.issues.map((issue) => {
            const path = issue.path.join('.');
            return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
        }),
    );
}

function dedupeTargets(input: ActorInput): ActorInput {
    return {
        ...input,
        fromUsers: [...new Set(input.fromUsers)],
        tweetIds: [...new Set(input.tweetIds)],
        hashtags: [...new Set(input.hashtags)],
    };
}

/**
 * Projects the validated input onto the pure filter type. A bare `YYYY-MM-DD`
 * bounds the whole day inclusively at both ends, which is what "inclusive window"
 * means to someone typing a date rather than a timestamp.
 */
export function toFilters(input: ActorInput): Filters {
    return {
        hashtags: input.hashtags,
        since: input.since === undefined ? null : startOfDay(input.since),
        until: input.until === undefined ? null : endOfDay(input.until),
        language: input.language ?? null,
        minLikes: input.minLikes ?? null,
        minRetweets: input.minRetweets ?? null,
        minReplies: input.minReplies ?? null,
        onlyVerified: input.onlyVerified,
        mediaType: input.mediaType,
        includeReplies: input.includeReplies,
        includeRetweets: input.includeRetweets,
    };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function startOfDay(value: string): Date {
    return new Date(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
}

function endOfDay(value: string): Date {
    return new Date(DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : value);
}
