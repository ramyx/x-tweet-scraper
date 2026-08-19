import type { Clock } from '../domain/types.js';
import { systemClock } from '../domain/types.js';

/**
 * Guest token lifecycle (assessment §7): acquire, cache, rotate and refresh.
 *
 * The unit of identity is the **session**, not the run: a token minted through one
 * proxy IP and replayed through another is a visitor teleporting between networks,
 * which is one of the cheapest bot signals there is. Tokens are therefore keyed by
 * session and rotate together with the IP that minted them.
 *
 * The HTTP call is injected, so every behaviour below is testable without network.
 */

/** Performs the actual `POST /1.1/guest/activate.json` for one session. */
export interface GuestTokenMinter {
    mint(sessionId: string): Promise<string>;
}

export interface GuestTokenRecord {
    readonly token: string;
    /** Epoch ms. */
    readonly mintedAt: number;
}

/** Serialisable pool state, so a migrated run resumes without a minting storm. */
export type GuestTokenSnapshot = Readonly<Record<string, GuestTokenRecord>>;

export interface GuestTokenPoolOptions {
    readonly minter: GuestTokenMinter;
    /** Refreshed proactively well before X expires them. Default 2h. */
    readonly ttlMs?: number;
    /** Hard ceiling on mints for the whole run. */
    readonly mintBudget?: number;
    readonly clock?: Clock;
}

export class GuestTokenBudgetExhaustedError extends Error {
    constructor(budget: number) {
        super(`guest token mint budget exhausted (${budget})`);
        this.name = 'GuestTokenBudgetExhaustedError';
    }
}

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

export class GuestTokenPool {
    readonly #minter: GuestTokenMinter;
    readonly #ttlMs: number;
    readonly #budget: number;
    readonly #clock: Clock;

    readonly #tokens = new Map<string, GuestTokenRecord>();
    /** Sessions with a mint already in flight, so concurrency does not multiply it. */
    readonly #inFlight = new Map<string, Promise<string>>();
    #minted = 0;

    constructor(options: GuestTokenPoolOptions) {
        this.#minter = options.minter;
        this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
        this.#budget = options.mintBudget ?? 8;
        this.#clock = options.clock ?? systemClock;
    }

    /** A valid token for this session, minting one only when there is no fresh one. */
    async get(sessionId: string): Promise<string> {
        const cached = this.#tokens.get(sessionId);
        if (cached !== undefined && !this.#isExpired(cached)) return cached.token;

        return this.#mintOnce(sessionId);
    }

    /**
     * Discards the current token and mints a replacement. Called when X rejects the
     * credential rather than the request.
     */
    async rotate(sessionId: string): Promise<string> {
        this.#tokens.delete(sessionId);
        return this.#mintOnce(sessionId);
    }

    /**
     * Coalesces concurrent mints for the same session. Without this, ten requests
     * hitting a 403 together mint ten tokens and burn the budget on the first stumble.
     */
    async #mintOnce(sessionId: string): Promise<string> {
        const pending = this.#inFlight.get(sessionId);
        if (pending !== undefined) return pending;

        if (this.#minted >= this.#budget) {
            throw new GuestTokenBudgetExhaustedError(this.#budget);
        }

        const attempt = this.#minter
            .mint(sessionId)
            .then((token) => {
                this.#minted += 1;
                this.#tokens.set(sessionId, { token, mintedAt: this.#clock.now().getTime() });
                return token;
            })
            .finally(() => {
                // Never cache a rejection: the next caller must be free to try again.
                this.#inFlight.delete(sessionId);
            });

        this.#inFlight.set(sessionId, attempt);
        return attempt;
    }

    #isExpired(record: GuestTokenRecord): boolean {
        return this.#clock.now().getTime() - record.mintedAt >= this.#ttlMs;
    }

    /** How many tokens this run has minted. Reported in the run summary. */
    get minted(): number {
        return this.#minted;
    }

    get budgetExhausted(): boolean {
        return this.#minted >= this.#budget;
    }

    /** For persisting across a migration. */
    snapshot(): GuestTokenSnapshot {
        return Object.fromEntries(this.#tokens);
    }

    /** Restores cached tokens, dropping any that have already aged out. */
    restore(snapshot: GuestTokenSnapshot | undefined): void {
        if (snapshot === undefined) return;

        for (const [sessionId, record] of Object.entries(snapshot)) {
            if (!this.#isExpired(record)) this.#tokens.set(sessionId, record);
        }
    }
}
