import { describe, expect, it } from 'vitest';
import {
    InputValidationError,
    parseInput,
    SEARCH_UNSUPPORTED_MESSAGE,
    toFilters,
} from '../src/app/input.js';

function issuesOf(raw: unknown): string[] {
    try {
        parseInput(raw);
        throw new Error('expected validation to fail');
    } catch (error: unknown) {
        if (error instanceof InputValidationError) return error.issues;
        throw error;
    }
}

describe('parseInput', () => {
    it('accepts a minimal target and applies the documented defaults', () => {
        const input = parseInput({ fromUsers: ['apify'] });

        expect(input).toMatchObject({
            fromUsers: ['apify'],
            includeReplies: false,
            includeRetweets: false,
            mediaType: 'any',
            onlyVerified: false,
            sortBy: 'latest',
            maxResults: 100,
        });
    });

    it('normalises handles: strips @, lowercases, deduplicates', () => {
        const input = parseInput({ fromUsers: ['@Apify', 'apify', 'ElonMusk'] });

        expect(input.fromUsers).toEqual(['apify', 'elonmusk']);
    });

    it('normalises hashtags the same way', () => {
        expect(parseInput({ fromUsers: ['a'], hashtags: ['#BuildInPublic', 'buildinpublic'] }).hashtags).toEqual([
            'buildinpublic',
        ]);
    });

    describe('targets', () => {
        it('requires at least one', () => {
            expect(issuesOf({})).toContain('fromUsers: Provide at least one target: fromUsers or tweetIds.');
        });

        it('accepts tweetIds alone', () => {
            expect(parseInput({ tweetIds: ['20'] }).tweetIds).toEqual(['20']);
        });

        it('accepts the short ids the earliest tweets have', () => {
            // jack's first tweet is id `20`. A minimum length would reject it.
            expect(parseInput({ tweetIds: ['20', '1899999999999999999'] }).tweetIds).toHaveLength(2);
        });

        it('rejects a handle that cannot exist', () => {
            expect(issuesOf({ fromUsers: ['not a handle!'] }).join()).toMatch(/not a valid X handle/);
        });

        it('rejects a non-numeric tweet id', () => {
            expect(issuesOf({ tweetIds: ['abc'] }).join()).toMatch(/numeric string/);
        });
    });

    describe('searchTerms (assessment §4: reject clearly, do not silently return nothing)', () => {
        it('is rejected with the observed reason', () => {
            const issues = issuesOf({ fromUsers: ['apify'], searchTerms: ['apify'] });

            expect(issues.join()).toContain(SEARCH_UNSUPPORTED_MESSAGE);
            expect(issues.join()).toMatch(/404/);
        });

        it('an empty array is not a search request', () => {
            expect(() => parseInput({ fromUsers: ['apify'], searchTerms: [] })).not.toThrow();
        });
    });

    describe('tamper resistance (assessment §6)', () => {
        it('rejects undocumented fields rather than absorbing them', () => {
            // An input that tries to assert its own entitlement must not merely be
            // ignored — it must fail loudly.
            expect(issuesOf({ fromUsers: ['apify'], tier: 'paid' }).join()).toMatch(/unrecognized|Unrecognized/);
            expect(issuesOf({ fromUsers: ['apify'], cap: 9999 }).join()).toMatch(/unrecognized|Unrecognized/);
        });

        it('still only exposes maxResults as a request, with a sane ceiling', () => {
            expect(parseInput({ fromUsers: ['a'], maxResults: 10_000 }).maxResults).toBe(10_000);
            expect(issuesOf({ fromUsers: ['a'], maxResults: 10_001 }).join()).toMatch(/less than or equal/i);
            expect(issuesOf({ fromUsers: ['a'], maxResults: 0 }).join()).toMatch(/greater than 0/i);
        });
    });

    describe('dates', () => {
        it('rejects a window that runs backwards', () => {
            const issues = issuesOf({ fromUsers: ['a'], since: '2026-05-01', until: '2026-01-01' });

            expect(issues.join()).toMatch(/must not be after/);
        });

        it('rejects an unparseable date', () => {
            expect(issuesOf({ fromUsers: ['a'], since: 'last tuesday' }).join()).toMatch(/ISO date/);
        });
    });

    it('rejects a language that is not ISO-639-1', () => {
        expect(issuesOf({ fromUsers: ['a'], language: 'english' }).join()).toMatch(/ISO-639-1/);
    });

    it('treats no input at all as missing targets, not a crash', () => {
        expect(issuesOf(null).join()).toMatch(/at least one target/);
    });
});

describe('toFilters', () => {
    it('maps unset filters to "no constraint"', () => {
        expect(toFilters(parseInput({ fromUsers: ['a'] }))).toEqual({
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
        });
    });

    it('bounds a bare date to the whole day, inclusively at both ends', () => {
        const filters = toFilters(parseInput({ fromUsers: ['a'], since: '2026-01-01', until: '2026-01-31' }));

        expect(filters.since?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
        expect(filters.until?.toISOString()).toBe('2026-01-31T23:59:59.999Z');
    });

    it('passes a full timestamp through unchanged', () => {
        const filters = toFilters(parseInput({ fromUsers: ['a'], since: '2026-01-01T08:30:00.000Z' }));

        expect(filters.since?.toISOString()).toBe('2026-01-01T08:30:00.000Z');
    });
});
