import { describe, expect, it } from 'vitest';
import {
    GuestTokenBudgetExhaustedError,
    GuestTokenPool,
    type GuestTokenMinter,
} from '../src/x/guestToken.js';
import type { Clock } from '../src/domain/types.js';

/** A clock the test moves by hand. */
function movableClock(startIso = '2026-08-19T12:00:00.000Z') {
    let now = new Date(startIso).getTime();
    const clock: Clock = { now: () => new Date(now) };
    return { clock, advance: (ms: number) => (now += ms) };
}

/** Counts mints, and can be made slow or failing. */
function countingMinter(
    behaviour: (sessionId: string, call: number) => Promise<string> = async (s, n) => `${s}-token-${n}`,
): GuestTokenMinter & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        async mint(sessionId: string): Promise<string> {
            calls.push(sessionId);
            return behaviour(sessionId, calls.length);
        },
    };
}

describe('GuestTokenPool', () => {
    it('mints once and reuses the token for the same session', async () => {
        const minter = countingMinter();
        const pool = new GuestTokenPool({ minter });

        expect(await pool.get('s1')).toBe('s1-token-1');
        expect(await pool.get('s1')).toBe('s1-token-1');
        expect(minter.calls).toEqual(['s1']);
    });

    it('keeps one token per session, since a token belongs to the IP that minted it', async () => {
        const minter = countingMinter();
        const pool = new GuestTokenPool({ minter });

        const [a, b] = [await pool.get('s1'), await pool.get('s2')];

        expect(a).not.toBe(b);
        expect(minter.calls).toEqual(['s1', 's2']);
    });

    it('coalesces concurrent mints instead of minting one per caller', async () => {
        // Ten requests hitting a 403 together must not burn ten tokens.
        let resolve: (token: string) => void = () => {};
        const minter = countingMinter(
            () => new Promise<string>((r) => { resolve = r; }),
        );
        const pool = new GuestTokenPool({ minter });

        const waiters = Promise.all(Array.from({ length: 10 }, () => pool.get('s1')));
        resolve('one-token');

        expect(await waiters).toEqual(Array<string>(10).fill('one-token'));
        expect(minter.calls).toEqual(['s1']);
        expect(pool.minted).toBe(1);
    });

    it('does not cache a failed mint', async () => {
        let shouldFail = true;
        const minter = countingMinter(async (s, n) => {
            if (shouldFail) throw new Error('activate.json is down');
            return `${s}-token-${n}`;
        });
        const pool = new GuestTokenPool({ minter });

        await expect(pool.get('s1')).rejects.toThrow('activate.json is down');

        shouldFail = false;
        expect(await pool.get('s1')).toBe('s1-token-2');
    });

    it('refreshes proactively once the token ages out', async () => {
        const { clock, advance } = movableClock();
        const minter = countingMinter();
        const pool = new GuestTokenPool({ minter, clock, ttlMs: 1000 });

        expect(await pool.get('s1')).toBe('s1-token-1');
        advance(999);
        expect(await pool.get('s1')).toBe('s1-token-1');
        advance(1);
        expect(await pool.get('s1')).toBe('s1-token-2');
    });

    it('rotate discards the current token and mints a replacement', async () => {
        const minter = countingMinter();
        const pool = new GuestTokenPool({ minter });

        await pool.get('s1');

        expect(await pool.rotate('s1')).toBe('s1-token-2');
        expect(await pool.get('s1')).toBe('s1-token-2');
        expect(pool.minted).toBe(2);
    });

    describe('mint budget', () => {
        it('refuses to mint past the budget rather than hammering X', async () => {
            const pool = new GuestTokenPool({ minter: countingMinter(), mintBudget: 2 });

            await pool.rotate('s1');
            await pool.rotate('s1');

            await expect(pool.rotate('s1')).rejects.toBeInstanceOf(GuestTokenBudgetExhaustedError);
            expect(pool.budgetExhausted).toBe(true);
        });
    });

    describe('persistence across a migration', () => {
        it('restores cached tokens so a resumed run does not re-mint everything', async () => {
            const { clock } = movableClock();
            const first = new GuestTokenPool({ minter: countingMinter(), clock });
            await first.get('s1');
            await first.get('s2');

            const resumedMinter = countingMinter();
            const resumed = new GuestTokenPool({ minter: resumedMinter, clock });
            resumed.restore(first.snapshot());

            expect(await resumed.get('s1')).toBe('s1-token-1');
            expect(await resumed.get('s2')).toBe('s2-token-2');
            expect(resumedMinter.calls).toEqual([]);
        });

        it('drops tokens that aged out while the run was down', async () => {
            const { clock, advance } = movableClock();
            const first = new GuestTokenPool({ minter: countingMinter(), clock, ttlMs: 1000 });
            await first.get('s1');
            const snapshot = first.snapshot();

            advance(5000);
            const resumed = new GuestTokenPool({ minter: countingMinter(), clock, ttlMs: 1000 });
            resumed.restore(snapshot);

            expect(await resumed.get('s1')).toBe('s1-token-1');
        });

        it('tolerates a missing snapshot', () => {
            const pool = new GuestTokenPool({ minter: countingMinter() });

            expect(() => pool.restore(undefined)).not.toThrow();
        });
    });
});
