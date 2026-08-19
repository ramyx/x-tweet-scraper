import type { FilterReason } from '../domain/types.js';
import type { PageSkipReason } from '../x/decode/timeline.js';

/**
 * Run summary (assessment §7): requested vs fetched vs pushed, the limited flag,
 * and error counts. Also the transparency §6 asks for when the cap applies.
 */

export type TargetStatus = 'ok' | 'protected' | 'suspended' | 'not_found' | 'unavailable' | 'error';

export interface TargetSummary {
    readonly pages: number;
    readonly fetched: number;
    readonly kept: number;
    readonly status: TargetStatus;
    readonly message?: string;
}

export interface RunSummary {
    readonly requested: number;
    /** Tweets decoded from X, before filtering. */
    readonly fetched: number;
    readonly pushed: number;
    readonly limited: boolean;
    readonly reason: string | null;
    readonly cap: number;
    readonly entitlement: { tier: string; source: string };
    readonly targets: Readonly<Record<string, TargetSummary>>;
    readonly filteredOut: Readonly<Partial<Record<FilterReason, number>>>;
    readonly skipped: Readonly<Partial<Record<PageSkipReason, number>>>;
    readonly errors: Readonly<Record<string, number>>;
    readonly requests: number;
    readonly retries: number;
    readonly guestTokensMinted: number;
    readonly durationMs: number;
}

/** Mutable accumulator; `build()` freezes it into the reported shape. */
export class SummaryBuilder {
    readonly #targets = new Map<string, TargetSummary>();
    readonly #filteredOut: Partial<Record<FilterReason, number>> = {};
    readonly #skipped: Partial<Record<PageSkipReason, number>> = {};
    readonly #errors: Record<string, number> = {};
    #fetched = 0;

    constructor(private readonly startedAt: number) {}

    countFetched(n: number): void {
        this.#fetched += n;
    }

    countFiltered(reason: FilterReason): void {
        this.#filteredOut[reason] = (this.#filteredOut[reason] ?? 0) + 1;
    }

    countSkipped(skipped: Readonly<Partial<Record<PageSkipReason, number>>>): void {
        for (const [reason, count] of Object.entries(skipped)) {
            const key = reason as PageSkipReason;
            this.#skipped[key] = (this.#skipped[key] ?? 0) + (count ?? 0);
        }
    }

    countError(kind: string): void {
        this.#errors[kind] = (this.#errors[kind] ?? 0) + 1;
    }

    recordTarget(name: string, summary: TargetSummary): void {
        this.#targets.set(name, summary);
    }

    build(parts: {
        requested: number;
        pushed: number;
        limited: boolean;
        reason: string | null;
        cap: number;
        entitlement: { tier: string; source: string };
        requests: number;
        retries: number;
        guestTokensMinted: number;
        now: number;
    }): RunSummary {
        return {
            requested: parts.requested,
            fetched: this.#fetched,
            pushed: parts.pushed,
            limited: parts.limited,
            reason: parts.reason,
            // Infinity does not survive JSON, and a null cap reads as "no ceiling".
            cap: Number.isFinite(parts.cap) ? parts.cap : parts.requested,
            entitlement: parts.entitlement,
            targets: Object.fromEntries(this.#targets),
            filteredOut: { ...this.#filteredOut },
            skipped: { ...this.#skipped },
            errors: { ...this.#errors },
            requests: parts.requests,
            retries: parts.retries,
            guestTokensMinted: parts.guestTokensMinted,
            durationMs: parts.now - this.startedAt,
        };
    }
}
