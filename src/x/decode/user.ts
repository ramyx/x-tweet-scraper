import { z } from 'zod';
import type { AuthorEntity } from '../../domain/types.js';

/**
 * Decoder for X's User payload.
 *
 * Written against responses captured on 2026-08-19. The important thing it encodes:
 * **the User object no longer carries `legacy`.** X moved the fields we need to
 * `core`, `relationship_counts` and `verification`. Anything written against the
 * old `legacy.screen_name` / `legacy.followers_count` layout silently decodes to
 * nothing today.
 *
 * Everything optional is optional on purpose. X adds and removes keys without
 * notice, so a missing field must degrade one value, never fail a run.
 */

const UserResultSchema = z.object({
    __typename: z.string().optional(),
    rest_id: z.string(),
    core: z.object({
        name: z.string(),
        screen_name: z.string(),
        created_at: z.string().optional(),
    }),
    relationship_counts: z
        .object({
            followers: z.number().int().nonnegative(),
            following: z.number().int().nonnegative(),
        })
        .optional(),
    verification: z
        .object({
            verified: z.boolean().optional(),
            /** e.g. "Business", "Government". Present without `verified` being true. */
            verified_type: z.string().optional(),
        })
        .optional(),
    is_blue_verified: z.boolean().optional(),
    privacy: z.object({ protected: z.boolean().optional() }).optional(),
});

/** An account we can read, plus the flags a caller needs to decide whether to. */
export interface DecodedUser {
    readonly author: AuthorEntity;
    readonly isProtected: boolean;
}

export type UserUnavailableReason = 'not_found' | 'suspended' | 'protected' | 'unavailable';

export type DecodedUserResult =
    | { readonly ok: true; readonly user: DecodedUser }
    | { readonly ok: false; readonly reason: UserUnavailableReason; readonly message: string };

/**
 * Verification is three independent signals and none of them is sufficient alone:
 * @jack is Blue-verified while `verification.verified` is `false`, and @apify is
 * neither yet carries `verified_type: "Business"`. Treating either as unverified
 * would give the `onlyVerified` filter the wrong answer, so any signal counts.
 */
function isVerified(user: z.infer<typeof UserResultSchema>): boolean {
    return (
        user.verification?.verified === true ||
        user.is_blue_verified === true ||
        user.verification?.verified_type != null
    );
}

/** Decodes the `data.user.result` node of a `UserByScreenName` response. */
export function decodeUserResult(raw: unknown): DecodedUserResult {
    const unavailable = readUnavailable(raw);
    if (unavailable) return unavailable;

    const parsed = UserResultSchema.safeParse(raw);
    if (!parsed.success) {
        return {
            ok: false,
            reason: 'unavailable',
            message: `unexpected user payload: ${parsed.error.issues
                .map((i) => `${i.path.join('.')} ${i.message}`)
                .join('; ')}`,
        };
    }

    const user = parsed.data;
    return {
        ok: true,
        user: {
            author: {
                id: user.rest_id,
                username: user.core.screen_name,
                name: user.core.name,
                verified: isVerified(user),
                followers: user.relationship_counts?.followers ?? 0,
                following: user.relationship_counts?.following ?? 0,
            },
            isProtected: user.privacy?.protected === true,
        },
    };
}

/** Recognises the "this account is not readable" shapes before schema validation. */
function readUnavailable(raw: unknown): DecodedUserResult | null {
    if (raw == null || typeof raw !== 'object') {
        return { ok: false, reason: 'not_found', message: 'no user node in response' };
    }

    const node = raw as Record<string, unknown>;
    if (node['__typename'] !== 'UserUnavailable') return null;

    const reason = typeof node['reason'] === 'string' ? node['reason'] : '';
    const message =
        typeof node['message'] === 'string' ? node['message'] : `user unavailable: ${reason}`;

    if (reason === 'Suspended') return { ok: false, reason: 'suspended', message };
    if (reason === 'Protected') return { ok: false, reason: 'protected', message };
    return { ok: false, reason: 'unavailable', message };
}

const EnvelopeSchema = z.object({
    data: z.object({ user: z.object({ result: z.unknown() }).optional() }).optional(),
    errors: z.array(z.object({ message: z.string() })).optional(),
});

/** Decodes a whole `UserByScreenName` response body. */
export function decodeUserByScreenName(body: unknown): DecodedUserResult {
    const envelope = EnvelopeSchema.safeParse(body);
    if (!envelope.success) {
        return { ok: false, reason: 'unavailable', message: 'unrecognised response envelope' };
    }

    const result = envelope.data.data?.user?.result;
    if (result === undefined) {
        // X reports a missing handle as a GraphQL error with an empty data node.
        const message = envelope.data.errors?.[0]?.message ?? 'user not found';
        return { ok: false, reason: 'not_found', message };
    }

    return decodeUserResult(result);
}
