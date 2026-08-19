import type { DatasetItem, Entitlement, ResultSink } from './types.js';

/**
 * Free-tier enforcement (assessment §6).
 *
 * Two properties make this the gate rather than a suggestion:
 *
 * 1. It is the single write path to the dataset. Nothing else may reach the sink,
 *    so there is exactly one place to audit — and a lint rule keeps it that way.
 * 2. It is applied where results are *emitted*, not by clamping `maxResults` up
 *    front. Callers consult `remaining()` before fetching another page, so a capped
 *    run also stops requesting data instead of fetching it and throwing it away.
 *
 * The cap itself comes from an {@link Entitlement} resolved by a server we control.
 * Nothing in the actor input can raise it: a larger `maxResults` is a request, and
 * the guard only ever takes the smaller of the two.
 */

/** Hard ceiling for unentitled runs. Not reachable from input, by construction. */
export const FREE_TIER_CAP = 10;

export interface QuotaStats {
    readonly pushed: number;
    /** The effective ceiling actually applied: `min(entitlement.cap, requested)`. */
    readonly cap: number;
    /** What the input asked for. */
    readonly requested: number;
    /** True when entitlement — not the request — is what bounded the run. */
    readonly limited: boolean;
    readonly reason: string | null;
}

export interface QuotaGuardOptions {
    readonly entitlement: Entitlement;
    /** `maxResults` from the validated input. A request, never an authority. */
    readonly requested: number;
    readonly sink: ResultSink;
    /**
     * Items already emitted by an earlier incarnation of this run. Restored from
     * persisted state after a migration so an interrupted run resumes its budget
     * instead of starting a fresh one.
     */
    readonly alreadyPushed?: number;
}

export class QuotaGuard {
    /** Truly private: unreachable from outside the class, including by callers that hold the instance. */
    #pushed: number;

    readonly #cap: number;
    readonly #requested: number;
    readonly #limited: boolean;
    readonly #reason: string | null;
    readonly #sink: ResultSink;

    constructor(options: QuotaGuardOptions) {
        const { entitlement, requested, sink, alreadyPushed = 0 } = options;

        this.#sink = sink;
        this.#requested = requested;
        this.#cap = Math.min(entitlement.cap, requested);
        this.#limited = entitlement.cap < requested;
        this.#reason = this.#limited ? (entitlement.reason ?? `${entitlement.tier}_tier`) : null;
        this.#pushed = alreadyPushed;
    }

    /** How many more items may still be emitted. Pagers check this before fetching. */
    remaining(): number {
        return Math.max(0, this.#cap - this.#pushed);
    }

    exhausted(): boolean {
        return this.remaining() === 0;
    }

    /**
     * The only way an item reaches the dataset.
     *
     * @returns `true` if the item was emitted, `false` once the cap is reached.
     */
    async offer(item: DatasetItem): Promise<boolean> {
        if (this.exhausted()) return false;

        await this.#sink.push(item);
        this.#pushed += 1;
        return true;
    }

    stats(): QuotaStats {
        return {
            pushed: this.#pushed,
            cap: this.#cap,
            requested: this.#requested,
            limited: this.#limited,
            reason: this.#reason,
        };
    }
}
