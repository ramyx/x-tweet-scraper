/**
 * Retry policy (assessment §7): exponential backoff with jitter, bounded budgets,
 * and a classification that separates what is worth retrying from what is not.
 *
 * Pure and injectable — the delay function takes its randomness as a parameter so
 * the behaviour can be asserted instead of observed.
 */

export type FailureClass =
    /** Transient. Back off and try again: 429, 5xx, socket errors. */
    | 'retryable'
    /** The credential is stale. Rotate the guest token, then the session. */
    | 'auth'
    /** Our request was wrong in a way the response tells us how to fix. */
    | 'schema'
    /** Nothing to be gained by repeating it. */
    | 'fatal';

export interface HttpFailure {
    readonly status?: number | undefined;
    /** Node socket error code, when the request never got a response. */
    readonly code?: string | undefined;
    readonly body?: string | undefined;
}

const TRANSIENT_SOCKET_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'ENOTFOUND',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * A dropped keep-alive socket surfaces as ECONNRESET. It is not congestion — the
 * pool simply handed out a connection the server had already closed — so it is
 * retried immediately rather than after a backoff.
 */
export function isStaleSocket(failure: HttpFailure): boolean {
    return failure.status === undefined && failure.code === 'ECONNRESET';
}

export function classify(failure: HttpFailure): FailureClass {
    if (failure.status === undefined) {
        return failure.code !== undefined && TRANSIENT_SOCKET_CODES.has(failure.code)
            ? 'retryable'
            : 'fatal';
    }

    const { status } = failure;
    if (status === 429 || status >= 500) return 'retryable';
    if (status === 401) return 'auth';
    if (status === 403) return isBadGuestToken(failure.body) ? 'auth' : 'fatal';
    // X answers an unknown persisted-query id with 404, which means our cached
    // query id went stale — recoverable by re-reading them from the web bundles.
    if (status === 404) return 'schema';
    if (status === 400) return hasMissingFeatures(failure.body) ? 'schema' : 'fatal';
    return 'fatal';
}

function isBadGuestToken(body: string | undefined): boolean {
    if (body === undefined) return false;
    return /bad guest token|"code":\s*239|"code":\s*37/i.test(body);
}

export function hasMissingFeatures(body: string | undefined): boolean {
    return body !== undefined && body.includes('cannot be null');
}

/**
 * X names the feature flags it wants in the 400 body, so the error is
 * self-describing: read them, default them to `true`, retry once.
 */
export function missingFeatures(body: string | undefined): string[] {
    if (body === undefined) return [];
    const named = /(?:features|fieldToggles) cannot be null: ([^"}\]]+)/.exec(body);
    if (named?.[1] == null) return [];

    return named[1]
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
}

export interface BackoffOptions {
    readonly baseMs: number;
    readonly capMs: number;
    /** Injectable for deterministic tests. Must return [0, 1). */
    readonly random: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 400, capMs: 15_000, random: Math.random };

/**
 * Exponential backoff with jitter, scaled to [50%, 100%] of the ceiling.
 *
 * The jitter is the point: without it, every worker that got a 429 at the same
 * moment retries at the same moment, and the synchronised stampede keeps the
 * server exactly as overloaded as it was.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = DEFAULT_BACKOFF): number {
    const ceiling = Math.min(options.capMs, options.baseMs * 2 ** Math.max(0, attempt));
    return Math.round(ceiling * (0.5 + options.random() * 0.5));
}

/**
 * How long X asks us to wait, when it says so. `x-rate-limit-reset` is an epoch
 * in seconds; `retry-after` is a delay in seconds.
 */
export function retryAfterMs(headers: Readonly<Record<string, string | undefined>>, now: number): number | null {
    const retryAfter = Number(headers['retry-after']);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;

    const reset = Number(headers['x-rate-limit-reset']);
    if (!Number.isFinite(reset) || reset <= 0) return null;

    const waitMs = reset * 1000 - now;
    return waitMs > 0 ? waitMs : null;
}

/**
 * A run-wide ceiling on retries, so one broken target cannot spend the whole time
 * budget while the others starve. When it is exhausted the run finishes with what
 * it has and says so, rather than hanging.
 */
export class RetryBudget {
    #used = 0;

    constructor(readonly limit: number) {}

    /** @returns `false` when the budget is spent and the caller must give up. */
    consume(): boolean {
        if (this.#used >= this.limit) return false;
        this.#used += 1;
        return true;
    }

    get used(): number {
        return this.#used;
    }

    get exhausted(): boolean {
        return this.#used >= this.limit;
    }
}

/** `50 + 5 per target` — generous for a normal run, finite for a broken one. */
export function budgetFor(targetCount: number): RetryBudget {
    return new RetryBudget(50 + 5 * targetCount);
}
