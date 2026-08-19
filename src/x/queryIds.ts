import type { Clock } from '../domain/types.js';
import { systemClock } from '../domain/types.js';
import { PINNED_QUERY_IDS } from './queryIds.pinned.js';

/**
 * Runtime resolution of X's per-operation query ids.
 *
 * X uses *persisted queries*: the client does not send a GraphQL document, it
 * sends an id that names one stored server-side. Those ids are regenerated on
 * every web deploy, so they are the single most common reason a scraper like this
 * rots. They are not secret either — they ship in the public web bundles, which is
 * where we read them from.
 *
 * Resolution order, first hit wins:
 *   1. a snapshot cached from an earlier run, while it is still fresh
 *   2. live extraction from X's own JavaScript bundles
 *   3. the pinned map captured at build time
 *
 * A 404 from the gateway means the id we used is stale, so callers invalidate it
 * and the registry re-extracts — once per run, not once per request.
 */

const HOME_URL = 'https://x.com/i/flow/login';
const BUNDLE_URL_PATTERN = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\s]+\.js/g;

/** Minified bundles emit the pair in both orders depending on the chunk. */
const FORWARD_PATTERN = /queryId:"([^"]+)",operationName:"([^"]+)"/g;
const REVERSE_PATTERN = /operationName:"([^"]+)",queryId:"([^"]+)"/g;

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export interface QueryIdSnapshot {
    readonly ids: Readonly<Record<string, string>>;
    /** Epoch ms of extraction. */
    readonly fetchedAt: number;
}

/** Fetches text over HTTP. Injected so the registry is testable offline. */
export interface TextFetcher {
    fetchText(url: string): Promise<string>;
}

/** Where a snapshot survives between runs — the Apify key-value store in production. */
export interface SnapshotStore {
    load(): Promise<QueryIdSnapshot | undefined>;
    save(snapshot: QueryIdSnapshot): Promise<void>;
}

export interface QueryIdRegistryOptions {
    readonly fetcher: TextFetcher;
    readonly store?: SnapshotStore;
    readonly ttlMs?: number;
    readonly clock?: Clock;
    readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Pulls every `{queryId, operationName}` pair out of bundle source.
 *
 * Pure and exported for its own test: the extraction is the part that breaks when
 * X changes its build, and it should be provable against a sample without network.
 */
export function extractQueryIds(source: string): Record<string, string> {
    const ids: Record<string, string> = {};

    for (const match of source.matchAll(FORWARD_PATTERN)) {
        const [, queryId, operationName] = match;
        if (queryId !== undefined && operationName !== undefined) ids[operationName] = queryId;
    }
    for (const match of source.matchAll(REVERSE_PATTERN)) {
        const [, operationName, queryId] = match;
        if (queryId !== undefined && operationName !== undefined) ids[operationName] = queryId;
    }

    return ids;
}

export function extractBundleUrls(html: string): string[] {
    return [...new Set(html.match(BUNDLE_URL_PATTERN) ?? [])];
}

export class QueryIdRegistry {
    readonly #fetcher: TextFetcher;
    readonly #store: SnapshotStore | undefined;
    readonly #ttlMs: number;
    readonly #clock: Clock;
    readonly #log: (message: string, data?: Record<string, unknown>) => void;

    #ids: Record<string, string> = {};
    #fetchedAt = 0;
    /** One live extraction per run: a bad deploy must not trigger a fetch storm. */
    #extraction: Promise<void> | null = null;
    #extracted = false;
    readonly #invalidated = new Set<string>();

    constructor(options: QueryIdRegistryOptions) {
        this.#fetcher = options.fetcher;
        this.#store = options.store;
        this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
        this.#clock = options.clock ?? systemClock;
        this.#log = options.log ?? (() => {});
    }

    /** Loads a cached snapshot if one is still fresh. Safe to call more than once. */
    async warmUp(): Promise<void> {
        if (this.#store === undefined) return;

        const snapshot = await this.#store.load().catch(() => undefined);
        if (snapshot === undefined) return;

        if (this.#clock.now().getTime() - snapshot.fetchedAt >= this.#ttlMs) {
            this.#log('queryIds: cached snapshot is stale, will re-extract');
            return;
        }

        this.#ids = { ...snapshot.ids };
        this.#fetchedAt = snapshot.fetchedAt;
        this.#log('queryIds: loaded from cache', { operations: Object.keys(this.#ids).length });
    }

    async get(operation: string): Promise<string> {
        const cached = this.#ids[operation];
        if (cached !== undefined && !this.#invalidated.has(operation)) return cached;

        await this.#extractOnce();

        const extracted = this.#ids[operation];
        if (extracted !== undefined && !this.#invalidated.has(operation)) return extracted;

        const pinned = PINNED_QUERY_IDS[operation];
        if (pinned !== undefined) {
            this.#log('queryIds: falling back to the pinned map', { operation });
            return pinned;
        }

        throw new Error(`no query id available for operation "${operation}"`);
    }

    /** Called when the gateway 404s an operation: the id we used has expired. */
    invalidate(operation: string): void {
        this.#invalidated.add(operation);
        delete this.#ids[operation];
        // Allow exactly one more extraction, in case the cached snapshot was stale.
        this.#extraction = null;
        this.#extracted = false;
        this.#log('queryIds: invalidated', { operation });
    }

    async #extractOnce(): Promise<void> {
        if (this.#extracted) return;
        this.#extraction ??= this.#extract().finally(() => {
            this.#extracted = true;
            this.#extraction = null;
        });
        return this.#extraction;
    }

    async #extract(): Promise<void> {
        try {
            const html = await this.#fetcher.fetchText(HOME_URL);
            const bundles = extractBundleUrls(html);
            if (bundles.length === 0) {
                this.#log('queryIds: no bundle urls found in the page');
                return;
            }

            const sources = await Promise.all(
                bundles.map((url) => this.#fetcher.fetchText(url).catch(() => '')),
            );

            const ids = extractQueryIds(sources.join('\n'));
            const found = Object.keys(ids).length;
            if (found === 0) {
                this.#log('queryIds: bundles yielded no operations');
                return;
            }

            this.#ids = { ...this.#ids, ...ids };
            this.#fetchedAt = this.#clock.now().getTime();
            this.#invalidated.clear();
            this.#log('queryIds: extracted from bundles', { operations: found, bundles: bundles.length });

            await this.#store
                ?.save({ ids: this.#ids, fetchedAt: this.#fetchedAt })
                .catch(() => this.#log('queryIds: could not persist the snapshot'));
        } catch (error: unknown) {
            // Extraction failing is survivable — the pinned map covers it.
            this.#log('queryIds: extraction failed', { error: String(error) });
        }
    }

    /** Everything currently resolved. For the run summary. */
    get resolved(): Readonly<Record<string, string>> {
        return { ...this.#ids };
    }
}
