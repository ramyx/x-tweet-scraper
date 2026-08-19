import { Actor, log } from 'apify';

/**
 * Entry point. Wiring only — every decision lives in a module that can be tested
 * without the platform. See docs/02 for the layering rule.
 */
await Actor.init();

try {
    log.info('x-tweet-scraper starting', { env: Actor.getEnv().actorRunId ?? 'local' });

    // TODO(block 2): input validation, entitlement resolution, run orchestration.

    await Actor.exit();
} catch (err: unknown) {
    log.exception(err as Error, 'Run failed');
    await Actor.exit({ exitCode: 1 });
}
