import { Actor } from 'apify';
import type { DatasetItem, ResultSink } from '../domain/types.js';

/**
 * The one place in this codebase that writes to the dataset.
 *
 * Deliberately a dumb pipe: no counting, no filtering, no decision of any kind.
 * Every judgement about whether an item may be emitted belongs to the quota guard,
 * which is the only holder of this sink. A lint rule keeps `pushData` confined to
 * this file so the free-tier gate has exactly one surface to audit (§6).
 */
export const apifyDatasetSink: ResultSink = {
    async push(item: DatasetItem): Promise<void> {
        await Actor.pushData(item);
    },
};
