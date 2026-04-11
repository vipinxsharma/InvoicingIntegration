/**
 * Unit tests – Duplicate Invoice Prevention
 *
 * Verifies that the idempotency key strategy prevents double-billing
 * across all billing types.
 */

import {
  buildIdempotencyKey,
  calculateDuePeriod,
  parseDate,
  toDateString,
} from '../../../src/modules/billing/rules-engine';
import type { BillingSchedule } from '../../../src/types/billing';

function makeSchedule(
  overrides: Partial<BillingSchedule> & { billingType: BillingSchedule['billingType'] },
): BillingSchedule {
  return {
    id: 'sched-dup-001',
    contractId: 'contract-dup-001',
    bitrixDealId: 'deal-dup-001',
    amount: 500,
    currency: 'USD',
    startDate: parseDate('2026-01-01'),
    isActive: true,
    dayOfMonth: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('Duplicate invoice prevention via idempotency keys', () => {
  it('same schedule + same day → same idempotency key (monthly)', () => {
    const schedule = makeSchedule({ billingType: 'monthly' });
    const p1 = calculateDuePeriod(schedule, parseDate('2026-01-01'));
    const p2 = calculateDuePeriod(schedule, parseDate('2026-01-01'));

    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(p1!.idempotencyKey).toBe(p2!.idempotencyKey);
  });

  it('same schedule + different month → different idempotency key (monthly)', () => {
    const schedule = makeSchedule({ billingType: 'monthly' });
    const p1 = calculateDuePeriod(schedule, parseDate('2026-01-01'));
    const p2 = calculateDuePeriod(schedule, parseDate('2026-02-01'));

    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(p1!.idempotencyKey).not.toBe(p2!.idempotencyKey);
  });

  it('different schedules + same period → different idempotency keys', () => {
    const s1 = makeSchedule({ id: 'sched-A', billingType: 'monthly' });
    const s2 = makeSchedule({ id: 'sched-B', billingType: 'monthly' });

    const p1 = calculateDuePeriod(s1, parseDate('2026-01-01'));
    const p2 = calculateDuePeriod(s2, parseDate('2026-01-01'));

    expect(p1!.idempotencyKey).not.toBe(p2!.idempotencyKey);
  });

  it('quarterly: Q1 and Q2 have different keys', () => {
    const schedule = makeSchedule({ billingType: 'quarterly', amount: 3000 });
    const q1 = calculateDuePeriod(schedule, parseDate('2026-01-01'));
    const q2 = calculateDuePeriod(schedule, parseDate('2026-04-01'));

    expect(q1).not.toBeNull();
    expect(q2).not.toBeNull();
    expect(q1!.idempotencyKey).not.toBe(q2!.idempotencyKey);
  });

  it('annual: year 1 and year 2 have different keys', () => {
    const schedule = makeSchedule({ billingType: 'annual', amount: 12000 });
    const y1 = calculateDuePeriod(schedule, parseDate('2026-01-01'));
    const y2 = calculateDuePeriod(schedule, parseDate('2027-01-01'));

    expect(y1).not.toBeNull();
    expect(y2).not.toBeNull();
    expect(y1!.idempotencyKey).not.toBe(y2!.idempotencyKey);
  });

  it('one-time invoice has stable key regardless of how many times computed', () => {
    const schedule = makeSchedule({
      billingType: 'one_time',
      startDate: parseDate('2026-05-01'),
      endDate: parseDate('2026-05-01'),
    });

    const p1 = calculateDuePeriod(schedule, parseDate('2026-05-01'));
    const p2 = calculateDuePeriod(schedule, parseDate('2026-05-01'));

    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(p1!.idempotencyKey).toBe(p2!.idempotencyKey);
  });

  it('milestone idempotency key is deterministic and period-scoped', () => {
    const dueDate = parseDate('2026-03-01');
    const key1 = buildIdempotencyKey('sched-001', 'milestone', dueDate, dueDate);
    const key2 = buildIdempotencyKey('sched-001', 'milestone', dueDate, dueDate);
    expect(key1).toBe(key2);
  });

  it('milestone idempotency key differs from recurring key on same day', () => {
    const date = parseDate('2026-03-01');
    const recurringKey = buildIdempotencyKey('sched-001', 'monthly', date, addOneMonth(date));
    const milestoneKey = buildIdempotencyKey('sched-001', 'milestone', date, date);
    expect(recurringKey).not.toBe(milestoneKey);
  });

  it('produces 12 distinct idempotency keys for 12 months of monthly billing', () => {
    const schedule = makeSchedule({ billingType: 'monthly' });
    const keys = new Set<string>();

    for (let month = 0; month < 12; month++) {
      const asOf = new Date(Date.UTC(2026, month, 1));
      const period = calculateDuePeriod(schedule, asOf);
      if (period) keys.add(period.idempotencyKey);
    }

    expect(keys.size).toBe(12);
  });

  it('produces 4 distinct idempotency keys for 4 quarters', () => {
    const schedule = makeSchedule({ billingType: 'quarterly', amount: 3000 });
    const keys = new Set<string>();

    for (const month of [0, 3, 6, 9]) {
      const asOf = new Date(Date.UTC(2026, month, 1));
      const period = calculateDuePeriod(schedule, asOf);
      if (period) keys.add(period.idempotencyKey);
    }

    expect(keys.size).toBe(4);
  });
});

// ─── Guard: scheduler running twice on same day ────────────────────────────────

describe('Scheduler idempotency guard', () => {
  it('same schedule evaluated at different hours on same day yields same key', () => {
    const schedule = makeSchedule({ billingType: 'monthly' });

    // Simulate scheduler running at 00:01 and 23:59 on the same calendar day
    const morning = new Date('2026-01-01T00:01:00.000Z');
    const evening = new Date('2026-01-01T23:59:00.000Z');

    const p1 = calculateDuePeriod(schedule, morning);
    const p2 = calculateDuePeriod(schedule, evening);

    // Both should match the same billing period
    if (p1 && p2) {
      expect(p1.idempotencyKey).toBe(p2.idempotencyKey);
    } else {
      // If date is in UTC the hours should not affect the date comparison
      // Both should be non-null
      expect(p1).not.toBeNull();
    }
  });
});

// ─── Helper ───────────────────────────────────────────────────────────────────

function addOneMonth(date: Date): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}
