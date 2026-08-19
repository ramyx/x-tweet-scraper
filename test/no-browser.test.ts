import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Assessment §3: any browser automation engine is an automatic fail. That is too
 * important to leave to code review, so it is machine-checked against the lockfile.
 *
 * Matching is on exact package names, not substrings. `electron-to-chromium` — a
 * version lookup TABLE pulled in by browserslist -> header-generator -> got-scraping —
 * would trip a naive substring check while shipping no browser at all. Banning by
 * substring would also force us to drop the very library that makes our HTTP requests
 * look like a real browser's.
 */
const FORBIDDEN_PACKAGES = new Set([
    'playwright',
    'playwright-core',
    'playwright-chromium',
    'playwright-firefox',
    'playwright-webkit',
    'puppeteer',
    'puppeteer-core',
    'selenium-webdriver',
    'webdriverio',
    'chromium',
    'chrome-launcher',
    'electron',
    'jsdom',
    'happy-dom',
]);

/** Scoped families whose whole namespace is a browser payload. */
const FORBIDDEN_SCOPES = ['@sparticuz/', '@puppeteer/', '@playwright/'];

interface Lockfile {
    packages?: Record<string, unknown>;
}

/** "node_modules/a/node_modules/@scope/b" -> "@scope/b" */
function packageNameOf(lockPath: string): string | null {
    const marker = 'node_modules/';
    const at = lockPath.lastIndexOf(marker);
    if (at === -1) return null;
    return lockPath.slice(at + marker.length);
}

describe('no browser automation (assessment §3)', () => {
    const lock = JSON.parse(
        readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
    ) as Lockfile;

    const installed = Object.keys(lock.packages ?? {})
        .map(packageNameOf)
        .filter((name): name is string => name !== null);

    it('resolves at least the direct dependencies (guards against an empty lockfile)', () => {
        expect(installed).toContain('apify');
        expect(installed).toContain('got-scraping');
    });

    it('has no browser engine anywhere in the dependency tree', () => {
        const offenders = installed.filter(
            (name) =>
                FORBIDDEN_PACKAGES.has(name) ||
                FORBIDDEN_SCOPES.some((scope) => name.startsWith(scope)),
        );
        expect(offenders).toEqual([]);
    });
});
