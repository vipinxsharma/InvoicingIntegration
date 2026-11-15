/**
 * Billing Rules Engine
 *
 * FULLY DETERMINISTIC – no external calls, no AI.
 * Given a billing schedule and a reference date, this module answers:
 *   1. Is an invoice due today?
 *   2. What period does it cover?
 *   3. What is its idempotency key?
 *
 * It also creates BillingSchedule and BillingMilestone rows from
 * a parsed ContractTerms object.
 */

import type { PoolClient } from 'pg';
import type {
  BillingSchedule,
  BillingMilestone,
  BillingPeriod,
  ContractTerms,
  ScheduleBillingType,
} from '../../types/billing';

// ─── Date arithmetic helpers ─────────────────────────────────────────────────

export function addMonths(date: Date, months: number): Date {
  const originalDay = date.getUTCDate();
  const rawMonth = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(rawMonth / 12);
  // Proper modulo that handles negative months too
  const targetMonth = ((rawMonth % 12) + 12) % 12;
  // Last calendar day of the target month (UTC)
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(targetYear, targetMonth, Math.min(originalDay, lastDay)),
  );
}

export function addQuarters(date: Date, quarters: number): Date {
  return addMonths(date, quarters * 3);
}

export function addYears(date: Date, years: number): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

/** Format a Date to YYYY-MM-DD (UTC date, no time zone shift) */
export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parse YYYY-MM-DD into a Date at midnight UTC */
export function parseDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

/** Returns true if two dates refer to the same calendar day (UTC) */
export function isSameDay(a: Date, b: Date): boolean {
  return toDateString(a) === toDateString(b);
}

// ─── Idempotency key ─────────────────────────────────────────────────────────

/**
 * Deterministic key: same schedule + same period → same key.
 * Stored in invoice_records.idempotency_key (UNIQUE constraint).
 */
export function buildIdempotencyKey(
  scheduleId: string,
  billingType: string,
  periodStart: Date,
  periodEnd: Date,
): string {
  return [
    scheduleId,
    billingType,
    toDateString(periodStart),
    toDateString(periodEnd),
  ].join('::');
}

// ─── Due-date calculation ────────────────────────────────────────────────────

/**
 * Returns the billing period for the current cycle (relative to `asOf`).
 * Returns null if no invoice is due on `asOf`.
 */
export function calculateDuePeriod(
  schedule: BillingSchedule,
  asOf: Date,
): BillingPeriod | null {
  const { billingType, startDate, endDate, dayOfMonth } = schedule;
  const today = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
  );

  // Contract not started yet
  if (today < startDate) return null;

  // Contract has ended
  if (endDate && today > endDate) return null;

  switch (billingType) {
    case 'monthly':
      return calcRecurringPeriod(schedule, today, 1, 'month', dayOfMonth ?? 1);
    case 'quarterly':
      return calcRecurringPeriod(schedule, today, 3, 'month', dayOfMonth ?? 1);
    case 'annual':
      return calcRecurringPeriod(schedule, today, 12, 'month', dayOfMonth ?? 1);
    case 'one_time':
      return calcOneTimePeriod(schedule, today);
    case 'milestone':
      // Milestones are handled separately via BillingMilestone rows
      return null;
    default:
      return null;
  }
}

function calcRecurringPeriod(
  schedule: BillingSchedule,
  today: Date,
  periodMonths: number,
  _unit: 'month',
  billingDay: number,
): BillingPeriod | null {
  // Walk forward from start date in `periodMonths` steps
  // until we find the period whose billing day matches today
  let periodStart = new Date(schedule.startDate);

  // Align periodStart to billing day
  periodStart = setDayOfMonth(periodStart, billingDay);

  let iteration = 0;
  const maxIterations = 600; // safety cap

  while (iteration++ < maxIterations) {
    const periodEnd = addMonths(periodStart, periodMonths);
    const billingDate = setDayOfMonth(new Date(periodStart), billingDay);

    if (isSameDay(billingDate, today)) {
      return {
        periodStart,
        periodEnd: new Date(
          Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate()) - 1,
        ),
        idempotencyKey: buildIdempotencyKey(
          schedule.id,
          schedule.billingType,
          periodStart,
          addMonths(periodStart, periodMonths),
        ),
        amount: schedule.amount,
        currency: schedule.currency,
      };
    }

    if (billingDate > today) break; // Passed today, not due

    periodStart = addMonths(periodStart, periodMonths);
  }

  return null;
}

function calcOneTimePeriod(
  schedule: BillingSchedule,
  today: Date,
): BillingPeriod | null {
  const billingDate = new Date(schedule.startDate);
  if (!isSameDay(billingDate, today)) return null;

  const periodEnd = schedule.endDate ?? schedule.startDate;
  return {
    periodStart: schedule.startDate,
    periodEnd: new Date(periodEnd),
    idempotencyKey: buildIdempotencyKey(
      schedule.id,
      schedule.billingType,
      schedule.startDate,
      new Date(periodEnd),
    ),
    amount: schedule.amount,
    currency: schedule.currency,
  };
}

function setDayOfMonth(date: Date, day: number): Date {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
  );
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

// ─── Milestone due check ─────────────────────────────────────────────────────

export function isMilestoneDue(
  milestone: BillingMilestone,
  asOf: Date,
): boolean {
  if (milestone.isBilled) return false;
  const dueDate = new Date(milestone.dueDate);
  // Invoice on the due date or if overdue (past due but not yet billed)
  return dueDate <= asOf;
}

// ─── Schedule / milestone creation ───────────────────────────────────────────

/**
 * Persist BillingSchedule and BillingMilestone rows for the given terms.
 * Called inside a transaction from the webhook handler.
 */
export async function createSchedulesFromTerms(
  contractId: string,
  bitrixDealId: string,
  terms: ContractTerms,
  client: PoolClient,
): Promise<void> {
  const { billingType } = terms;

  if (billingType === 'hybrid') {
    if (!terms.hybridSchedules?.length) {
      throw new Error('Hybrid contract missing hybridSchedules');
    }
    for (const hs of terms.hybridSchedules) {
      await insertSchedule(
        client,
        contractId,
        bitrixDealId,
        hs.billingType,
        hs.amount,
        terms.currency,
        hs.startDate,
        hs.endDate,
        terms,
      );
    }
  } else {
    await insertSchedule(
      client,
      contractId,
      bitrixDealId,
      billingType as ScheduleBillingType,
      terms.amount,
      terms.currency,
      terms.startDate,
      terms.endDate,
      terms,
    );
  }
}

async function insertSchedule(
  client: PoolClient,
  contractId: string,
  bitrixDealId: string,
  billingType: ScheduleBillingType,
  amount: number,
  currency: string,
  startDate: string,
  endDate: string | undefined,
  terms: ContractTerms,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO billing_schedules
       (contract_id, bitrix_deal_id, billing_type, amount, currency,
        start_date, end_date, day_of_month, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      contractId,
      bitrixDealId,
      billingType,
      amount,
      currency,
      startDate,
      endDate ?? null,
      1, // Default: bill on 1st of each period
      JSON.stringify({ paymentTermsDays: terms.paymentTermsDays, notes: terms.notes }),
    ],
  );

  const scheduleId = result.rows[0]?.id;
  if (!scheduleId) throw new Error('Failed to insert billing schedule');

  // Insert milestones if applicable
  if (
    (billingType === 'milestone') &&
    terms.milestones?.length
  ) {
    for (const m of terms.milestones) {
      await client.query(
        `INSERT INTO billing_milestones
           (schedule_id, name, amount, due_date, description)
         VALUES ($1,$2,$3,$4,$5)`,
        [scheduleId, m.name, m.amount, m.dueDate, m.description ?? null],
      );
    }
  }
}
