import type { GuestTokenSnapshot } from '../x/guestToken.js';

/**
 * Resumable run state (assessment §7). Apify can migrate a run to another machine;
 * without this it would start over.
 *
 * `pushed` is the security-relevant field. If a resumed run restarted its counter,
 * a free user could abort and resume repeatedly and collect ten items each time,
 * so the quota guard is reconstructed from this number rather than from zero.
 */

export interface RunState {
    readonly version: 1;
    /** Items already emitted. Restores the cap, not just the progress. */
    pushed: number;
    /** Global dedupe set across every target. */
    seenIds: string[];
    /** handle → last Bottom cursor, so a resumed run continues where it stopped. */
    cursors: Record<string, string | null>;
    doneTargets: string[];
    guestTokens: GuestTokenSnapshot;
    startedAt: string;
}

export function emptyState(startedAt: string): RunState {
    return {
        version: 1,
        pushed: 0,
        seenIds: [],
        cursors: {},
        doneTargets: [],
        guestTokens: {},
        startedAt,
    };
}

/** Accepts only state this build wrote; anything else starts clean. */
export function restoreState(raw: unknown, startedAt: string): RunState {
    if (raw == null || typeof raw !== 'object') return emptyState(startedAt);

    const candidate = raw as Partial<RunState>;
    if (candidate.version !== 1) return emptyState(startedAt);

    return {
        version: 1,
        pushed: typeof candidate.pushed === 'number' && candidate.pushed >= 0 ? candidate.pushed : 0,
        seenIds: Array.isArray(candidate.seenIds) ? candidate.seenIds.filter((id) => typeof id === 'string') : [],
        cursors: isRecord(candidate.cursors) ? candidate.cursors : {},
        doneTargets: Array.isArray(candidate.doneTargets)
            ? candidate.doneTargets.filter((t) => typeof t === 'string')
            : [],
        guestTokens: isRecord(candidate.guestTokens) ? (candidate.guestTokens as GuestTokenSnapshot) : {},
        startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : startedAt,
    };
}

function isRecord(value: unknown): value is Record<string, never> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Tracks ids across every target, so overlapping sources cannot produce duplicates. */
export class SeenSet {
    readonly #ids: Set<string>;

    constructor(initial: readonly string[] = []) {
        this.#ids = new Set(initial);
    }

    /** @returns `true` the first time an id is offered, `false` afterwards. */
    add(id: string): boolean {
        if (this.#ids.has(id)) return false;
        this.#ids.add(id);
        return true;
    }

    get size(): number {
        return this.#ids.size;
    }

    toArray(): string[] {
        return [...this.#ids];
    }
}
