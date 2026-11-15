/**
 * Scheduler
 *
 * Two cron jobs:
 *   1. Daily billing check  – iterates all active schedules, fires invoice generator
 *   2. Hourly retry job     – reprocesses items in the error queue
 */

import cron from 'node-cron';
import { config } from '../../config';
import { pool } from '../../db/client';
import { generateInvoice, generateMilestoneInvoice } from './invoice-generator';
import { processErrorQueue } from '../queue/retry-processor';
import { logger } from '../audit/logger';
import { calculateDuePeriod, isMilestoneDue, parseDate, toDateString } from './rules-engine';
import type { BillingSchedule, BillingMilestone } from '../../types/billing';

// ─── Schedule runner ──────────────────────────────────────────────────────────

export async function runBillingCheck(asOf: Date = new Date()): Promise<void> {
  logger.info('[scheduler] Starting daily billing check', {
    date: toDateString(asOf),
  });

  const [scheduleRows, milestoneRows] = await Promise.all([
    loadActiveSchedules(),
    loadDueMilestones(asOf),
  ]);

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  // ── Recurring / one-time schedules ─────────────────────────────────────────
  for (const schedule of scheduleRows) {
    if (schedule.billingType === 'milestone') {
      // Milestones handled separately below
      continue;
    }

    const period = calculateDuePeriod(schedule, asOf);
    if (!period) {
      skipped++;
      continue;
    }

    try {
      const result = await generateInvoice(schedule.id, asOf);
      if (result.isDuplicate) {
        skipped++;
      } else {
        processed++;
        logger.info('[scheduler] Invoice generated', {
          scheduleId: schedule.id,
          dealId: schedule.bitrixDealId,
          invoiceId: result.invoiceRecord.ledgersInvoiceId,
        });
      }
    } catch (err) {
      errors++;
      logger.error('[scheduler] Invoice generation failed', {
        scheduleId: schedule.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Milestone-based billing ────────────────────────────────────────────────
  for (const milestone of milestoneRows) {
    try {
      const result = await generateMilestoneInvoice(
        milestone.scheduleId,
        milestone.id,
        asOf,
      );
      if (result.isDuplicate) {
        skipped++;
      } else {
        processed++;
        logger.info('[scheduler] Milestone invoice generated', {
          milestoneId: milestone.id,
          scheduleId: milestone.scheduleId,
        });
      }
    } catch (err) {
      errors++;
      logger.error('[scheduler] Milestone invoice generation failed', {
        milestoneId: milestone.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('[scheduler] Daily billing check complete', {
    date: toDateString(asOf),
    processed,
    skipped,
    errors,
  });
}

// ─── Data loaders ────────────────────────────────────────────────────────────

async function loadActiveSchedules(): Promise<BillingSchedule[]> {
  const result = await pool.query<{
    id: string;
    contract_id: string;
    bitrix_deal_id: string;
    billing_type: string;
    amount: string;
    currency: string;
    start_date: Date;
    end_date: Date | null;
    day_of_month: number | null;
    is_active: boolean;
    metadata: Record<string, unknown> | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT * FROM billing_schedules WHERE is_active = TRUE ORDER BY created_at`,
  );

  return result.rows.map((r) => ({
    id: r.id,
    contractId: r.contract_id,
    bitrixDealId: r.bitrix_deal_id,
    billingType: r.billing_type as BillingSchedule['billingType'],
    amount: parseFloat(r.amount),
    currency: r.currency,
    startDate: r.start_date,
    endDate: r.end_date ?? undefined,
    dayOfMonth: r.day_of_month ?? undefined,
    isActive: r.is_active,
    metadata: r.metadata ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

async function loadDueMilestones(asOf: Date): Promise<BillingMilestone[]> {
  const dateStr = toDateString(asOf);
  const result = await pool.query<{
    id: string;
    schedule_id: string;
    name: string;
    amount: string;
    due_date: Date;
    description: string | null;
    is_billed: boolean;
    billed_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT bm.*
     FROM billing_milestones bm
     JOIN billing_schedules bs ON bs.id = bm.schedule_id
     WHERE bm.is_billed = FALSE
       AND bm.due_date  <= $1
       AND bs.is_active  = TRUE
     ORDER BY bm.due_date`,
    [dateStr],
  );

  return result.rows
    .map((r) => ({
      id: r.id,
      scheduleId: r.schedule_id,
      name: r.name,
      amount: parseFloat(r.amount),
      dueDate: r.due_date,
      description: r.description ?? undefined,
      isBilled: r.is_billed,
      billedAt: r.billed_at ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
    .filter((m) => isMilestoneDue(m, asOf));
}

// ─── Cron registration ────────────────────────────────────────────────────────

export function startScheduler(): void {
  if (!cron.validate(config.scheduler.billingCheckCron)) {
    throw new Error(
      `Invalid BILLING_CHECK_CRON expression: ${config.scheduler.billingCheckCron}`,
    );
  }
  if (!cron.validate(config.scheduler.retryProcessorCron)) {
    throw new Error(
      `Invalid RETRY_PROCESSOR_CRON expression: ${config.scheduler.retryProcessorCron}`,
    );
  }

  cron.schedule(config.scheduler.billingCheckCron, async () => {
    try {
      await runBillingCheck();
    } catch (err) {
      logger.error('[scheduler] Unhandled error in billing check', { err });
    }
  });

  cron.schedule(config.scheduler.retryProcessorCron, async () => {
    try {
      await processErrorQueue();
    } catch (err) {
      logger.error('[scheduler] Unhandled error in retry processor', { err });
    }
  });

  logger.info('[scheduler] Started', {
    billingCheck: config.scheduler.billingCheckCron,
    retryProcessor: config.scheduler.retryProcessorCron,
  });
}
