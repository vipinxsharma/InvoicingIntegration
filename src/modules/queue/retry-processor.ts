/**
 * Retry Processor
 *
 * Runs on a cron schedule.  For each retryable error_queue item it:
 *   1. Marks item as 'retrying'
 *   2. Replays the invoice generation
 *   3. On success → marks 'resolved'
 *   4. On failure → schedules next retry or promotes to 'dead_letter'
 */

import {
  fetchRetryableItems,
  markRetrying,
  markResolved,
  markFailed,
  scheduleNextRetry,
} from './error-queue';
import { generateInvoice, generateMilestoneInvoice } from '../billing/invoice-generator';
import { logger } from '../audit/logger';
import { toDateString } from '../billing/rules-engine';

export async function processErrorQueue(): Promise<void> {
  logger.info('[retry] Starting error queue processing');

  let processed = 0;
  let resolved = 0;
  let rescheduled = 0;
  let deadLettered = 0;

  // Use a transaction-level SKIP LOCKED to avoid double-processing
  // fetchRetryableItems uses FOR UPDATE SKIP LOCKED internally.
  // We process in batches to bound memory.
  const items = await fetchRetryableItems(50);

  for (const item of items) {
    await markRetrying(item.id);
    processed++;

    try {
      const context = item.context ?? {};
      const milestoneId = context['milestoneId'] as string | undefined;
      const asOf = new Date();

      if (milestoneId) {
        await generateMilestoneInvoice(item.scheduleId, milestoneId, asOf);
      } else {
        await generateInvoice(item.scheduleId, asOf);
      }

      await markResolved(item.id);
      resolved++;

      logger.info('[retry] Item resolved', {
        id: item.id,
        scheduleId: item.scheduleId,
        attempts: item.attempts + 1,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nextAttempts = item.attempts + 1;

      if (nextAttempts >= item.maxAttempts) {
        await markFailed(item.id, message);
        deadLettered++;
        logger.error('[retry] Item dead-lettered after max attempts', {
          id: item.id,
          scheduleId: item.scheduleId,
          attempts: nextAttempts,
          error: message,
        });
      } else {
        await scheduleNextRetry(item.id, nextAttempts);
        rescheduled++;
        logger.warn('[retry] Item rescheduled', {
          id: item.id,
          attempts: nextAttempts,
          maxAttempts: item.maxAttempts,
        });
      }
    }
  }

  logger.info('[retry] Error queue processing complete', {
    processed,
    resolved,
    rescheduled,
    deadLettered,
    asOf: toDateString(new Date()),
  });
}
