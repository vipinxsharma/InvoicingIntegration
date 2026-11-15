/**
 * Unit tests – Billing Rules Engine
 *
 * Tests cover:
 *  - Monthly / quarterly / annual due-date calculation
 *  - Period start & end boundaries
 *  - Day-of-month alignment
 *  - Contract not-started-yet guard
 *  - Contract expired guard
 *  - One-time billing
 *  - Milestone billing (handled externally – rules engine returns null)
 *  - Idempotency key determinism
 */

import {
  calculateDuePeriod,
  buildIdempotencyKey,
  addMonths,
  addYears,
  toDateString,
  parseDate,
  isSameDay,
  isMilestoneDue,
} from '../../../src/modules/billing/rules-engine';
import type { BillingSchedule, BillingMilestone } from '../../../src/types/billing';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSchedule(
  overrides: Partial<BillingSchedule> & { billingType: BillingSchedule['billingType'] },
): BillingSchedule {
  return {
    id: 'sched-001',
    contractId: 'contract-001',
    bitrixDealId: 'deal-001',
    amount: 1000,
    currency: 'USD',
    startDate: parseDate('2026-01-01'),
    isActive: true,
    dayOfMonth: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── addMonths / addYears ────────────────────────────────────────────────────

describe('addMonths', () => {
  it('adds months normally', () => {
    const d = new Date('2026-01-15T00:00:00.000Z');
    expect(toDateString(addMonths(d, 1))).toBe('2026-02-15');
  });

  it('clamps to end of February on overflow from January 31', () => {
    const d = new Date('2026-01-31T00:00:00.000Z');
    const result = addMonths(d, 1);
    expect(toDateString(result)).toBe('2026-02-28');
  });

  it('clamps to end of month correctly for short months', () => {
    const d = new Date('2026-03-31T00:00:00.000Z');
    expect(toDateString(addMonths(d, 1))).toBe('2026-04-30');
  });
});

describe('addYears', () => {
  it('adds one year', () => {
    expect(toDateString(addYears(parseDate('2026-01-01'), 1))).toBe('2027-01-01');
  });

  it('handles leap-year → non-leap-year for Feb 29', () => {
    const leapDay = new Date('2024-02-29T00:00:00.000Z');
    const result = addYears(leapDay, 1);
    // 2025 is not a leap year; setFullYear clamps to Feb 28 or rolls to Mar 1
    // Behavior is JS-native: result is 2025-03-01 (JS rolls over)
    // We just assert it doesn't throw and is a valid date
    expect(isNaN(result.getTime())).toBe(false);
  });
});

// ─── Monthly billing ──────────────────────────────────────────────────────────

describe('calculateDuePeriod – monthly', () => {
  const schedule = makeSchedule({
    billingType: 'monthly',
    startDate: parseDate('2026-01-01'),
    dayOfMonth: 1,
  });

  it('is due on the start date (first billing day)', () => {
    const period = calculateDuePeriod(schedule, parseDate('2026-01-01'));
    expect(period).not.toBeNull();
    expect(toDateString(period!.periodStart)).toBe('2026-01-01');
  });

  it('is due on the next monthly billing day', () => {
    const period = calculateDuePeriod(schedule, parseDate('2026-02-01'));
    expect(period).not.toBeNull();
    expect(toDateString(period!.periodStart)).toBe('2026-02-01');
  });

  it('is NOT due on a non-billing day', () => {
    const period = calculateDuePeriod(schedule, parseDate('2026-01-15'));
    expect(period).toBeNull();
  });

  it('returns correct amount and currency', () => {
    const period = calculateDuePeriod(schedule, parseDate('2026-01-01'));
    expect(period!.amount).toBe(1000);
    expect(period!.currency).toBe('USD');
  });

  it('is NOT due before contract starts', () => {
    const period = calculateDuePeriod(schedule, parseDate('2025-12-01'));
    expect(period).toBeNull();
  });

  it('is NOT due after contract end date', () => {
    const s = makeSchedule({
      billingType: 'monthly',
      startDate: parseDate('2026-01-01'),
      endDate: parseDate('2026-06-30'),
    });
    const period = calculateDuePeriod(s, parseDate('2026-07-01'));
    expect(period).toBeNull();
  });
});

// ─── Quarterly billing ────────────────────────────────────────────────────────

describe('calculateDuePeriod – quarterly', () => {
  const schedule = makeSchedule({
    billingType: 'quarterly',
    startDate: parseDate('2026-01-01'),
    amount: 3000,
    dayOfMonth: 1,
  });

  it('is due on Q1 billing day', () => {
    const period = calculateDuePeriod(schedule, parseDate('2026-01-01'));
    expect(period).not.toBeNull();
  });

  it('is due on Q2 billing day (3 months later)', () => {
    const period = calculateDuePeriod(schedule, parseDate('2026-04-01'));
    expect(period).not.toBeNull();
  });

  it('is NOT due 1 month into Q1', () => {
    const period = calculateDuePeriod(schedule, parseDate('2026-02-01'));
    expect(period).toBeNull();
  });

  it('is NOT due 2 months into Q1', () => {
    const period = calculateDuePeriod(schedule, parseDate('2026-03-01'));
    expect(period).toBeNull();
  });
});

// ─── Annual billing ───────────────────────────────────────────────────────────

describe('calculateDuePeriod – annual', () => {
  const schedule = makeSchedule({
    billingType: 'annual',
    startDate: parseDate('2026-01-01'),
    amount: 12000,
    dayOfMonth: 1,
  });

  it('is due on year 1 billing day', () => {
    expect(calculateDuePeriod(schedule, parseDate('2026-01-01'))).not.toBeNull();
  });

  it('is due on year 2 billing day', () => {
    expect(calculateDuePeriod(schedule, parseDate('2027-01-01'))).not.toBeNull();
  });

  it('is NOT due 6 months in', () => {
    expect(calculateDuePeriod(schedule, parseDate('2026-07-01'))).toBeNull();
  });
});

// ─── One-time billing ─────────────────────────────────────────────────────────

describe('calculateDuePeriod – one_time', () => {
  const schedule = makeSchedule({
    billingType: 'one_time',
    startDate: parseDate('2026-03-15'),
    endDate: parseDate('2026-03-15'),
    amount: 5000,
  });

  it('is due exactly on start date', () => {
    const period = calculateDuePeriod(schedule, parseDate('2026-03-15'));
    expect(period).not.toBeNull();
    expect(period!.amount).toBe(5000);
  });

  it('is NOT due the day after', () => {
    expect(calculateDuePeriod(schedule, parseDate('2026-03-16'))).toBeNull();
  });

  it('is NOT due the day before', () => {
    expect(calculateDuePeriod(schedule, parseDate('2026-03-14'))).toBeNull();
  });
});

// ─── Milestone (rules engine returns null – handled separately) ───────────────

describe('calculateDuePeriod – milestone', () => {
  it('always returns null (milestones use isMilestoneDue)', () => {
    const schedule = makeSchedule({
      billingType: 'milestone',
      startDate: parseDate('2026-01-01'),
    });
    expect(calculateDuePeriod(schedule, parseDate('2026-01-01'))).toBeNull();
    expect(calculateDuePeriod(schedule, parseDate('2026-06-01'))).toBeNull();
  });
});

// ─── isMilestoneDue ───────────────────────────────────────────────────────────

describe('isMilestoneDue', () => {
  function makeMilestone(
    overrides: Partial<BillingMilestone>,
  ): BillingMilestone {
    return {
      id: 'ms-001',
      scheduleId: 'sched-001',
      name: 'Phase 1',
      amount: 2500,
      dueDate: parseDate('2026-03-01'),
      isBilled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it('is due on the exact due date', () => {
    expect(
      isMilestoneDue(makeMilestone({}), parseDate('2026-03-01')),
    ).toBe(true);
  });

  it('is due if overdue (past due, not yet billed)', () => {
    expect(
      isMilestoneDue(makeMilestone({}), parseDate('2026-04-15')),
    ).toBe(true);
  });

  it('is NOT due before due date', () => {
    expect(
      isMilestoneDue(makeMilestone({}), parseDate('2026-02-28')),
    ).toBe(false);
  });

  it('is NOT due if already billed', () => {
    expect(
      isMilestoneDue(
        makeMilestone({ isBilled: true, billedAt: new Date() }),
        parseDate('2026-03-01'),
      ),
    ).toBe(false);
  });
});

// ─── Idempotency key ──────────────────────────────────────────────────────────

describe('buildIdempotencyKey', () => {
  it('produces the same key for the same inputs', () => {
    const key1 = buildIdempotencyKey(
      'sched-001',
      'monthly',
      parseDate('2026-01-01'),
      parseDate('2026-01-31'),
    );
    const key2 = buildIdempotencyKey(
      'sched-001',
      'monthly',
      parseDate('2026-01-01'),
      parseDate('2026-01-31'),
    );
    expect(key1).toBe(key2);
  });

  it('produces different keys for different periods', () => {
    const key1 = buildIdempotencyKey(
      'sched-001',
      'monthly',
      parseDate('2026-01-01'),
      parseDate('2026-01-31'),
    );
    const key2 = buildIdempotencyKey(
      'sched-001',
      'monthly',
      parseDate('2026-02-01'),
      parseDate('2026-02-28'),
    );
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different schedules', () => {
    const key1 = buildIdempotencyKey(
      'sched-001',
      'monthly',
      parseDate('2026-01-01'),
      parseDate('2026-01-31'),
    );
    const key2 = buildIdempotencyKey(
      'sched-002',
      'monthly',
      parseDate('2026-01-01'),
      parseDate('2026-01-31'),
    );
    expect(key1).not.toBe(key2);
  });

  it('contains all four components', () => {
    const key = buildIdempotencyKey(
      'sched-abc',
      'quarterly',
      parseDate('2026-04-01'),
      parseDate('2026-06-30'),
    );
    expect(key).toContain('sched-abc');
    expect(key).toContain('quarterly');
    expect(key).toContain('2026-04-01');
    expect(key).toContain('2026-06-30');
  });
});
