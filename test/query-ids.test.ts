import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    extractBundleUrls,
    extractQueryIds,
    QueryIdRegistry,
    type QueryIdSnapshot,
    type SnapshotStore,
    type TextFetcher,
} from '../src/x/queryIds.js';
import { PINNED_QUERY_IDS } from '../src/x/queryIds.pinned.js';
import type { Clock } from '../src/domain/types.js';

const BUNDLE_SAMPLE = readFileSync(
    new URL('./fixtures/client-web-bundle.sample.js', import.meta.url),
    'utf8',
);

function movableClock(startIso = '2026-08-19T12:00:00.000Z') {
    let now = new Date(startIso).getTime();
    const clock: Clock = { now: () => new Date(now) };
    return { clock, advance: (ms: number) => (now += ms) };
}

function fetcherOf(pages: Readonly<Record<string, string>>): TextFetcher & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        async fetchText(url: string): Promise<string> {
            calls.push(url);
            const page = pages[url];
            if (page === undefined) throw new Error(`unexpected fetch: ${url}`);
            return page;
        },
    };
}

const HOME = 'https://x.com/i/flow/login';
const BUNDLE = 'https://abs.twimg.com/responsive-web/client-web/main.dd6a5b6a.js';
const HOME_HTML = `<script src="${BUNDLE}"></script><script src="${BUNDLE}"></script>`;

describe('extractQueryIds', () => {
    it('reads the real minified bundle shipped by X', () => {
        const ids = extractQueryIds(BUNDLE_SAMPLE);

        expect(ids['UserByScreenName']).toBe('Gb-d6r0vxPOADdG62OEBpQ');
        expect(ids['UserTweets']).toBe('SXVCYB8XHSS25nzIljNtZA');
        expect(ids['TweetResultByRestId']).toBe('GZsN2Pc4knAoit6pXa4HSA');
    });

    it('matches both key orderings, which differ between chunks', () => {
        const forward = extractQueryIds('{queryId:"abc",operationName:"Foo"}');
        const reverse = extractQueryIds('{operationName:"Bar",queryId:"def"}');

        expect(forward['Foo']).toBe('abc');
        expect(reverse['Bar']).toBe('def');
    });

    it('returns nothing for source with no operations', () => {
        expect(extractQueryIds('console.log("hello")')).toEqual({});
    });
});

describe('extractBundleUrls', () => {
    it('collects client-web bundles and deduplicates them', () => {
        expect(extractBundleUrls(HOME_HTML)).toEqual([BUNDLE]);
    });

    it('ignores unrelated scripts', () => {
        expect(extractBundleUrls('<script src="https://example.com/app.js">')).toEqual([]);
    });
});

describe('QueryIdRegistry', () => {
    const pages = { [HOME]: HOME_HTML, [BUNDLE]: BUNDLE_SAMPLE };

    it('extracts live ids from X’s own bundles', async () => {
        const registry = new QueryIdRegistry({ fetcher: fetcherOf(pages) });

        expect(await registry.get('UserTweets')).toBe('SXVCYB8XHSS25nzIljNtZA');
    });

    it('extracts once per run, not once per lookup', async () => {
        const fetcher = fetcherOf(pages);
        const registry = new QueryIdRegistry({ fetcher });

        await registry.get('UserTweets');
        await registry.get('UserByScreenName');
        await registry.get('TweetResultByRestId');

        expect(fetcher.calls).toEqual([HOME, BUNDLE]);
    });

    it('coalesces concurrent lookups into a single extraction', async () => {
        const fetcher = fetcherOf(pages);
        const registry = new QueryIdRegistry({ fetcher });

        await Promise.all([registry.get('UserTweets'), registry.get('UserByScreenName')]);

        expect(fetcher.calls.filter((u) => u === HOME)).toHaveLength(1);
    });

    describe('fallbacks', () => {
        const failingFetcher: TextFetcher = {
            async fetchText(): Promise<string> {
                throw new Error('network down');
            },
        };

        it('falls back to the pinned map when extraction fails', async () => {
            const registry = new QueryIdRegistry({ fetcher: failingFetcher });

            expect(await registry.get('UserTweets')).toBe(PINNED_QUERY_IDS['UserTweets']);
        });

        it('falls back when the bundles yield nothing', async () => {
            const registry = new QueryIdRegistry({
                fetcher: fetcherOf({ [HOME]: HOME_HTML, [BUNDLE]: 'nothing useful here' }),
            });

            expect(await registry.get('UserTweets')).toBe(PINNED_QUERY_IDS['UserTweets']);
        });

        it('throws only for an operation nobody knows about', async () => {
            const registry = new QueryIdRegistry({ fetcher: failingFetcher });

            await expect(registry.get('NotARealOperation')).rejects.toThrow(/no query id/);
        });
    });

    describe('snapshot cache', () => {
        function storeOf(initial?: QueryIdSnapshot): SnapshotStore & { saved: QueryIdSnapshot[] } {
            const saved: QueryIdSnapshot[] = [];
            let current = initial;
            return {
                saved,
                async load() {
                    return current;
                },
                async save(snapshot) {
                    current = snapshot;
                    saved.push(snapshot);
                },
            };
        }

        it('serves a fresh cached snapshot without touching the network', async () => {
            const { clock } = movableClock();
            const fetcher = fetcherOf(pages);
            const store = storeOf({ ids: { UserTweets: 'CACHED' }, fetchedAt: clock.now().getTime() });
            const registry = new QueryIdRegistry({ fetcher, store, clock });

            await registry.warmUp();

            expect(await registry.get('UserTweets')).toBe('CACHED');
            expect(fetcher.calls).toEqual([]);
        });

        it('re-extracts once the snapshot ages past the TTL', async () => {
            const { clock, advance } = movableClock();
            const store = storeOf({ ids: { UserTweets: 'CACHED' }, fetchedAt: clock.now().getTime() });
            advance(7 * 60 * 60 * 1000);
            const registry = new QueryIdRegistry({ fetcher: fetcherOf(pages), store, clock });

            await registry.warmUp();

            expect(await registry.get('UserTweets')).toBe('SXVCYB8XHSS25nzIljNtZA');
        });

        it('persists what it extracted for the next run', async () => {
            const store = storeOf();
            const registry = new QueryIdRegistry({ fetcher: fetcherOf(pages), store });

            await registry.get('UserTweets');

            expect(store.saved).toHaveLength(1);
            expect(store.saved[0]?.ids['UserTweets']).toBe('SXVCYB8XHSS25nzIljNtZA');
        });

        it('survives a store that is unavailable', async () => {
            const broken: SnapshotStore = {
                async load() {
                    throw new Error('kv down');
                },
                async save() {
                    throw new Error('kv down');
                },
            };
            const registry = new QueryIdRegistry({ fetcher: fetcherOf(pages), store: broken });

            await registry.warmUp();

            expect(await registry.get('UserTweets')).toBe('SXVCYB8XHSS25nzIljNtZA');
        });
    });

    describe('invalidation', () => {
        it('re-extracts after a 404 says the cached id went stale', async () => {
            const { clock } = movableClock();
            const fetcher = fetcherOf(pages);
            const store: SnapshotStore = {
                async load() {
                    return { ids: { UserTweets: 'STALE' }, fetchedAt: clock.now().getTime() };
                },
                async save() {},
            };
            const registry = new QueryIdRegistry({ fetcher, store, clock });
            await registry.warmUp();

            expect(await registry.get('UserTweets')).toBe('STALE');

            registry.invalidate('UserTweets');

            expect(await registry.get('UserTweets')).toBe('SXVCYB8XHSS25nzIljNtZA');
            expect(fetcher.calls).toContain(HOME);
        });
    });
});
