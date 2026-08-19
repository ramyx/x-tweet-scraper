import { describe, expect, it } from 'vitest';
import { FREE_TIER_CAP, QuotaGuard } from '../src/domain/quota.js';
import { FAIL_CLOSED, FREE, makeItems, PAID, RecordingSink } from './helpers.js';

describe('QuotaGuard (assessment §6)', () => {
    it('caps a free user at 10 however large maxResults is', async () => {
        const sink = new RecordingSink();
        const guard = new QuotaGuard({ entitlement: FREE, requested: 1000, sink });

        for (const item of makeItems(500)) await guard.offer(item);

        expect(sink.items).toHaveLength(FREE_TIER_CAP);
        expect(guard.stats()).toMatchObject({
            pushed: 10,
            cap: 10,
            requested: 1000,
            limited: true,
            reason: 'free_tier',
        });
    });

    it('caps at 10 when entitlement could not be verified (fail-closed)', async () => {
        const sink = new RecordingSink();
        const guard = new QuotaGuard({ entitlement: FAIL_CLOSED, requested: 1000, sink });

        for (const item of makeItems(50)) await guard.offer(item);

        expect(sink.items).toHaveLength(FREE_TIER_CAP);
        expect(guard.stats().limited).toBe(true);
    });

    it('honours a smaller request: the input can lower the ceiling, never raise it', async () => {
        const sink = new RecordingSink();
        const guard = new QuotaGuard({ entitlement: FREE, requested: 3, sink });

        for (const item of makeItems(50)) await guard.offer(item);

        expect(sink.items).toHaveLength(3);
        // The request bound this run, not the entitlement, so it is not "limited".
        expect(guard.stats()).toMatchObject({ cap: 3, limited: false, reason: null });
    });

    it('gives a paid user the full requested amount', async () => {
        const sink = new RecordingSink();
        const guard = new QuotaGuard({ entitlement: PAID, requested: 100, sink });

        for (const item of makeItems(150)) await guard.offer(item);

        expect(sink.items).toHaveLength(100);
        expect(guard.stats()).toMatchObject({ limited: false, reason: null });
    });

    it('reports remaining budget and refuses items once exhausted', async () => {
        const guard = new QuotaGuard({ entitlement: FREE, requested: 1000, sink: new RecordingSink() });
        const items = makeItems(11);

        expect(guard.remaining()).toBe(10);
        expect(guard.exhausted()).toBe(false);

        for (const item of items.slice(0, 10)) {
            expect(await guard.offer(item)).toBe(true);
        }

        expect(guard.remaining()).toBe(0);
        expect(guard.exhausted()).toBe(true);
        expect(await guard.offer(items[10]!)).toBe(false);
    });

    it('resumes a migrated run instead of restarting its budget', async () => {
        const sink = new RecordingSink();
        const guard = new QuotaGuard({
            entitlement: FREE,
            requested: 1000,
            sink,
            alreadyPushed: FREE_TIER_CAP,
        });

        for (const item of makeItems(50)) await guard.offer(item);

        // Aborting and resuming must not hand out another 10.
        expect(sink.items).toHaveLength(0);
        expect(guard.stats().pushed).toBe(10);
    });

    it('stops the pager from fetching, not just from pushing', async () => {
        // §6 asks for enforcement at the emit point: a capped run must stop asking
        // upstream for data it can never emit.
        const pageSize = 100;
        let pagesFetched = 0;

        const drain = async (guard: QuotaGuard): Promise<void> => {
            while (!guard.exhausted()) {
                pagesFetched += 1;
                for (const item of makeItems(pageSize)) {
                    if (!(await guard.offer(item))) break;
                }
            }
        };

        await drain(new QuotaGuard({ entitlement: FREE, requested: 1000, sink: new RecordingSink() }));

        expect(pagesFetched).toBe(1);
    });
});
