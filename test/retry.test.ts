import { describe, expect, it } from 'vitest';
import {
    backoffDelay,
    budgetFor,
    classify,
    isStaleSocket,
    missingFeatures,
    retryAfterMs,
    RetryBudget,
} from '../src/infra/retry.js';

describe('classify', () => {
    it('retries rate limits and server errors', () => {
        expect(classify({ status: 429 })).toBe('retryable');
        expect(classify({ status: 500 })).toBe('retryable');
        expect(classify({ status: 503 })).toBe('retryable');
    });

    it('retries transient socket failures', () => {
        expect(classify({ code: 'ECONNRESET' })).toBe('retryable');
        expect(classify({ code: 'ETIMEDOUT' })).toBe('retryable');
        expect(classify({ code: 'UND_ERR_HEADERS_TIMEOUT' })).toBe('retryable');
    });

    it('does not retry a request that was simply wrong', () => {
        // Repeating a 400 just makes noise: the defect is on our side.
        expect(classify({ status: 400, body: '{"errors":[{"message":"whatever"}]}' })).toBe('fatal');
        expect(classify({ status: 422 })).toBe('fatal');
        expect(classify({ code: 'EACCES' })).toBe('fatal');
    });

    it('treats a stale credential as an auth failure, not a retry', () => {
        expect(classify({ status: 401 })).toBe('auth');
        expect(classify({ status: 403, body: '{"errors":[{"code":239,"message":"Bad guest token."}]}' })).toBe('auth');
    });

    it('treats a plain 403 as fatal: it is a wall, not a stale token', () => {
        expect(classify({ status: 403, body: '{"errors":[{"message":"Not authorized."}]}' })).toBe('fatal');
    });

    it('treats 404 as recoverable schema drift, since X answers stale query ids that way', () => {
        expect(classify({ status: 404 })).toBe('schema');
    });

    it('treats a missing-features 400 as recoverable, because the body says what is missing', () => {
        const body = '{"errors":[{"message":"The following features cannot be null: rweb_tipjar_consumption_enabled"}]}';

        expect(classify({ status: 400, body })).toBe('schema');
    });
});

describe('missingFeatures', () => {
    it('reads the flag names X names in its own error', () => {
        const body =
            '{"errors":[{"message":"The following features cannot be null: rweb_tipjar_consumption_enabled, responsive_web_graphql_timeline_navigation_enabled"}]}';

        expect(missingFeatures(body)).toEqual([
            'rweb_tipjar_consumption_enabled',
            'responsive_web_graphql_timeline_navigation_enabled',
        ]);
    });

    it('returns nothing when the body is not about features', () => {
        expect(missingFeatures('{"errors":[{"message":"Not authorized."}]}')).toEqual([]);
        expect(missingFeatures(undefined)).toEqual([]);
    });
});

describe('isStaleSocket', () => {
    it('distinguishes a dropped keep-alive socket from congestion', () => {
        // The pool handed out a connection the server had already closed. Retry
        // immediately: waiting helps nothing.
        expect(isStaleSocket({ code: 'ECONNRESET' })).toBe(true);
        expect(isStaleSocket({ status: 429 })).toBe(false);
        expect(isStaleSocket({ code: 'ETIMEDOUT' })).toBe(false);
    });
});

describe('backoffDelay', () => {
    const options = (random: number) => ({ baseMs: 400, capMs: 15_000, random: () => random });

    it('doubles the ceiling on each attempt', () => {
        const worstCase = options(1);

        expect(backoffDelay(0, worstCase)).toBe(400);
        expect(backoffDelay(1, worstCase)).toBe(800);
        expect(backoffDelay(2, worstCase)).toBe(1600);
        expect(backoffDelay(3, worstCase)).toBe(3200);
    });

    it('never exceeds the cap, however many attempts', () => {
        expect(backoffDelay(30, options(1))).toBe(15_000);
    });

    it('jitters within [50%, 100%] of the ceiling', () => {
        // Without jitter every worker that got a 429 at the same instant retries
        // at the same instant, and the stampede keeps the server down.
        expect(backoffDelay(2, options(0))).toBe(800);
        expect(backoffDelay(2, options(1))).toBe(1600);
    });

    it('produces a spread of delays over many draws', () => {
        const delays = new Set(Array.from({ length: 200 }, () => backoffDelay(3)));

        expect(delays.size).toBeGreaterThan(50);
        for (const delay of delays) {
            expect(delay).toBeGreaterThanOrEqual(1600);
            expect(delay).toBeLessThanOrEqual(3200);
        }
    });
});

describe('retryAfterMs', () => {
    const now = Date.parse('2026-08-19T12:00:00.000Z');

    it('honours retry-after in seconds', () => {
        expect(retryAfterMs({ 'retry-after': '30' }, now)).toBe(30_000);
    });

    it('converts x-rate-limit-reset from an epoch to a wait', () => {
        const reset = String(Math.floor(now / 1000) + 45);

        expect(retryAfterMs({ 'x-rate-limit-reset': reset }, now)).toBe(45_000);
    });

    it('ignores a reset that has already passed', () => {
        const reset = String(Math.floor(now / 1000) - 10);

        expect(retryAfterMs({ 'x-rate-limit-reset': reset }, now)).toBeNull();
    });

    it('returns null when X says nothing', () => {
        expect(retryAfterMs({}, now)).toBeNull();
        expect(retryAfterMs({ 'retry-after': 'soon' }, now)).toBeNull();
    });
});

describe('RetryBudget', () => {
    it('stops one broken target from spending the whole run', () => {
        const budget = new RetryBudget(3);

        expect([budget.consume(), budget.consume(), budget.consume()]).toEqual([true, true, true]);
        expect(budget.consume()).toBe(false);
        expect(budget.exhausted).toBe(true);
        expect(budget.used).toBe(3);
    });

    it('scales with the number of targets', () => {
        expect(budgetFor(0).limit).toBe(50);
        expect(budgetFor(10).limit).toBe(100);
    });
});
