import { Actor, log } from 'apify';
import { QuotaGuard } from './domain/quota.js';
import { apifyDatasetSink } from './infra/dataset.js';
import { resolveEntitlement } from './infra/entitlements.js';
import { UndiciHttpClient } from './infra/http.js';
import { budgetFor } from './infra/retry.js';
import { InputValidationError, parseInput, toFilters, type ActorInput } from './app/input.js';
import { runScrape } from './app/run.js';
import { restoreState } from './app/state.js';
import { SummaryBuilder } from './app/summary.js';
import { PUBLIC_WEB_BEARER, XClient, type Session } from './x/client.js';
import { GuestTokenPool } from './x/guestToken.js';
import { QueryIdRegistry, type QueryIdSnapshot } from './x/queryIds.js';

/**
 * Rebuilds the proxy options explicitly. The validated input allows unknown keys
 * through for forward compatibility, but only the documented ones are forwarded to
 * the platform.
 */
function toProxyOptions(
    configuration: ActorInput['proxyConfiguration'],
): Parameters<typeof Actor.createProxyConfiguration>[0] {
    if (configuration === undefined) return undefined;

    return {
        ...(configuration.useApifyProxy === undefined ? {} : { useApifyProxy: configuration.useApifyProxy }),
        ...(configuration.apifyProxyGroups === undefined ? {} : { apifyProxyGroups: configuration.apifyProxyGroups }),
        ...(configuration.apifyProxyCountry === undefined ? {} : { apifyProxyCountry: configuration.apifyProxyCountry }),
        ...(configuration.proxyUrls === undefined ? {} : { proxyUrls: configuration.proxyUrls }),
    };
}

const STATE_KEY = 'RUN_STATE';
const QUERY_IDS_KEY = 'QUERY_IDS';
const SUMMARY_KEY = 'RUN_SUMMARY';

await Actor.init();

const startedAt = Date.now();
const http = new UndiciHttpClient();

try {
    const input = parseInput(await Actor.getInput());
    const filters = toFilters(input);
    const env = Actor.getEnv();

    // ---- entitlement ------------------------------------------------------
    // Resolved before anything is fetched, and from a server we control. Nothing
    // in `input` participates: it can lower the ceiling, never raise it.
    const entitlement = await resolveEntitlement({
        http,
        identity: {
            userId: env.userId ?? null,
            runId: env.actorRunId ?? null,
            actorId: env.actorId ?? null,
            isAtHome: Actor.isAtHome(),
        },
        config: {
            serviceUrl: process.env['ENTITLEMENTS_URL'],
            sharedSecret: process.env['ENTITLEMENTS_SHARED_SECRET'],
            publicKey: process.env['ENTITLEMENTS_PUBLIC_KEY'],
        },
        log: (message, data) => log.info(message, data),
    });

    log.info('entitlement resolved', {
        tier: entitlement.tier,
        source: entitlement.source,
        reason: entitlement.reason,
    });

    // ---- state ------------------------------------------------------------
    const store = await Actor.openKeyValueStore();
    const state = restoreState(await store.getValue(STATE_KEY), new Date(startedAt).toISOString());
    if (state.pushed > 0) log.info('resuming a migrated run', { alreadyPushed: state.pushed });

    const persist = async (): Promise<void> => {
        await store.setValue(STATE_KEY, state);
    };
    Actor.on('migrating', () => {
        void persist();
    });
    const persistTimer = setInterval(() => void persist(), 10_000);

    // ---- transport --------------------------------------------------------
    const proxy = await Actor.createProxyConfiguration(toProxyOptions(input.proxyConfiguration));

    const tokens = new GuestTokenPool({
        mintBudget: Math.max(8, (input.fromUsers.length + input.tweetIds.length) * 2),
        minter: {
            async mint(sessionId: string): Promise<string> {
                const response = await http.request({
                    url: 'https://api.x.com/1.1/guest/activate.json',
                    method: 'POST',
                    headers: { authorization: `Bearer ${PUBLIC_WEB_BEARER}` },
                    proxyUrl: await proxy?.newUrl(sessionId),
                });
                const body = JSON.parse(response.body) as { guest_token?: string };
                if (body.guest_token === undefined) throw new Error('activate.json returned no guest token');
                return body.guest_token;
            },
        },
    });
    tokens.restore(state.guestTokens);

    const queryIds = new QueryIdRegistry({
        fetcher: {
            async fetchText(url: string): Promise<string> {
                return (await http.request({ url })).body;
            },
        },
        store: {
            async load(): Promise<QueryIdSnapshot | undefined> {
                return (await store.getValue<QueryIdSnapshot>(QUERY_IDS_KEY)) ?? undefined;
            },
            async save(snapshot: QueryIdSnapshot): Promise<void> {
                await store.setValue(QUERY_IDS_KEY, snapshot);
            },
        },
        log: (message, data) => log.debug(message, data),
    });
    await queryIds.warmUp();

    const client = new XClient({
        http,
        tokens,
        queryIds,
        budget: budgetFor(input.fromUsers.length + input.tweetIds.length),
        log: (message, data) => log.debug(message, data),
    });

    // ---- the only write path to the dataset -------------------------------
    const guard = new QuotaGuard({
        entitlement,
        requested: input.maxResults,
        sink: apifyDatasetSink,
        alreadyPushed: state.pushed,
    });

    // ---- run --------------------------------------------------------------
    const summary = new SummaryBuilder(startedAt);

    // One session per target, resolved up front: the proxy IP and the guest token
    // minted through it belong together, and both are reused across that target's
    // pages so the connection stays warm and the identity stays coherent.
    const targets = [...input.fromUsers, ...input.tweetIds.map((id) => `tweet-${id}`)];
    const sessions = new Map<string, Session>();
    for (const [index, target] of targets.entries()) {
        const id = `s${index + 1}`;
        sessions.set(target, { id, proxyUrl: await proxy?.newUrl(id) });
    }
    const fallbackSession: Session = { id: 's0', proxyUrl: await proxy?.newUrl('s0') };
    const sessionFor = (target: string): Session => sessions.get(target) ?? fallbackSession;

    await runScrape({
        client,
        guard,
        input,
        filters,
        state,
        summary,
        sessionFor,
        log: (message, data) => log.info(message, data),
        persist,
    });

    // ---- report -----------------------------------------------------------
    clearInterval(persistTimer);
    state.guestTokens = tokens.snapshot();
    await persist();

    const stats = guard.stats();
    const runSummary = summary.build({
        requested: input.maxResults,
        pushed: stats.pushed,
        limited: stats.limited,
        reason: stats.reason,
        cap: stats.cap,
        entitlement: { tier: entitlement.tier, source: entitlement.source },
        requests: client.stats.requests,
        retries: client.stats.retries,
        guestTokensMinted: tokens.minted,
        now: Date.now(),
    });

    if (stats.limited) {
        log.warning(
            `Free tier: results capped at ${stats.cap} (requested ${stats.requested}). ` +
                'Upgrade for higher limits.',
        );
    }
    log.info('run summary', { ...runSummary });
    await Actor.setValue(SUMMARY_KEY, runSummary);

    await http.close();
    await Actor.exit();
} catch (error: unknown) {
    await http.close();

    if (error instanceof InputValidationError) {
        log.error(error.message);
        await Actor.exit({ exitCode: 1, statusMessage: 'Invalid input' });
    } else {
        log.exception(error as Error, 'Run failed');
        await Actor.exit({ exitCode: 1, statusMessage: 'Run failed' });
    }
}
