/**
 * Unit tests – Contract Parser
 *
 * Tests the deterministic validation layer (parseAndValidate / validateTerms)
 * without calling the Claude API.
 *
 * The Claude API call is mocked for the end-to-end parseContractTerms test.
 */

jest.mock('@anthropic-ai/sdk');

import { parseAndValidate, ContractParseError } from '../../../src/modules/contract/parser';
import type { ContractTerms } from '../../../src/types/billing';

// ─── Valid inputs ─────────────────────────────────────────────────────────────

describe('parseAndValidate – valid inputs', () => {
  it('parses a minimal valid monthly contract', () => {
    const json = JSON.stringify({
      billingType: 'monthly',
      amount: 1000,
      currency: 'USD',
      startDate: '2026-01-01',
      paymentTermsDays: 30,
    });

    const terms = parseAndValidate(json);
    expect(terms.billingType).toBe('monthly');
    expect(terms.amount).toBe(1000);
    expect(terms.currency).toBe('USD');
    expect(terms.startDate).toBe('2026-01-01');
    expect(terms.paymentTermsDays).toBe(30);
  });

  it('parses a quarterly contract with end date', () => {
    const terms = parseAndValidate(
      JSON.stringify({
        billingType: 'quarterly',
        amount: 6000,
        currency: 'GBP',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        paymentTermsDays: 14,
      }),
    );

    expect(terms.billingType).toBe('quarterly');
    expect(terms.currency).toBe('GBP');
    expect(terms.endDate).toBe('2026-12-31');
  });

  it('parses an annual contract', () => {
    const terms = parseAndValidate(
      JSON.stringify({
        billingType: 'annual',
        amount: 24000,
        currency: 'EUR',
        startDate: '2026-01-01',
      }),
    );
    expect(terms.billingType).toBe('annual');
    expect(terms.amount).toBe(24000);
  });

  it('parses a one-time contract', () => {
    const terms = parseAndValidate(
      JSON.stringify({
        billingType: 'one_time',
        amount: 5000,
        currency: 'USD',
        startDate: '2026-06-15',
        endDate: '2026-06-15',
      }),
    );
    expect(terms.billingType).toBe('one_time');
    expect(terms.startDate).toBe('2026-06-15');
  });

  it('parses a milestone contract with milestones array', () => {
    const terms = parseAndValidate(
      JSON.stringify({
        billingType: 'milestone',
        amount: 10000,
        currency: 'USD',
        startDate: '2026-01-01',
        milestones: [
          { name: 'Discovery', amount: 2000, dueDate: '2026-02-01' },
          { name: 'Design', amount: 3000, dueDate: '2026-03-01', description: 'UX design phase' },
          { name: 'Build', amount: 5000, dueDate: '2026-05-01' },
        ],
      }),
    );
    expect(terms.billingType).toBe('milestone');
    expect(terms.milestones).toHaveLength(3);
    expect(terms.milestones![1]!.name).toBe('Design');
    expect(terms.milestones![1]!.description).toBe('UX design phase');
  });

  it('parses a hybrid contract with hybridSchedules', () => {
    const terms = parseAndValidate(
      JSON.stringify({
        billingType: 'hybrid',
        amount: 20000,
        currency: 'USD',
        startDate: '2026-01-01',
        hybridSchedules: [
          { billingType: 'one_time', amount: 5000, startDate: '2026-01-01' },
          { billingType: 'monthly', amount: 1250, startDate: '2026-02-01', endDate: '2026-12-31' },
        ],
        milestones: [
          { name: 'Final delivery', amount: 5000, dueDate: '2026-12-15' },
        ],
      }),
    );
    expect(terms.billingType).toBe('hybrid');
    expect(terms.hybridSchedules).toHaveLength(2);
    expect(terms.hybridSchedules![0]!.billingType).toBe('one_time');
  });

  it('strips markdown code fences before parsing', () => {
    const json = '```json\n{"billingType":"annual","amount":5000,"currency":"USD","startDate":"2026-01-01"}\n```';
    const terms = parseAndValidate(json);
    expect(terms.billingType).toBe('annual');
  });

  it('defaults paymentTermsDays to 30 when absent', () => {
    const terms = parseAndValidate(
      JSON.stringify({
        billingType: 'monthly',
        amount: 500,
        currency: 'USD',
        startDate: '2026-01-01',
      }),
    );
    expect(terms.paymentTermsDays).toBe(30);
  });

  it('defaults currency to USD when absent', () => {
    const terms = parseAndValidate(
      JSON.stringify({
        billingType: 'monthly',
        amount: 500,
        startDate: '2026-01-01',
      }),
    );
    expect(terms.currency).toBe('USD');
  });

  it('normalises currency code to uppercase', () => {
    const terms = parseAndValidate(
      JSON.stringify({
        billingType: 'monthly',
        amount: 500,
        currency: 'eur',
        startDate: '2026-01-01',
      }),
    );
    expect(terms.currency).toBe('EUR');
  });
});

// ─── Invalid inputs ───────────────────────────────────────────────────────────

describe('parseAndValidate – validation errors', () => {
  it('throws on invalid JSON', () => {
    expect(() => parseAndValidate('{not valid json')).toThrow(ContractParseError);
  });

  it('throws on invalid billingType', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          billingType: 'weekly', // not valid
          amount: 500,
          currency: 'USD',
          startDate: '2026-01-01',
        }),
      ),
    ).toThrow(ContractParseError);
  });

  it('throws on missing amount', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          billingType: 'monthly',
          currency: 'USD',
          startDate: '2026-01-01',
        }),
      ),
    ).toThrow(ContractParseError);
  });

  it('throws on zero amount', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          billingType: 'monthly',
          amount: 0,
          currency: 'USD',
          startDate: '2026-01-01',
        }),
      ),
    ).toThrow(ContractParseError);
  });

  it('throws on negative amount', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          billingType: 'monthly',
          amount: -100,
          currency: 'USD',
          startDate: '2026-01-01',
        }),
      ),
    ).toThrow(ContractParseError);
  });

  it('throws on missing startDate', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          billingType: 'monthly',
          amount: 1000,
          currency: 'USD',
        }),
      ),
    ).toThrow(ContractParseError);
  });

  it('throws on invalid startDate format', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          billingType: 'monthly',
          amount: 1000,
          currency: 'USD',
          startDate: '01/01/2026', // wrong format
        }),
      ),
    ).toThrow(ContractParseError);
  });

  it('throws on invalid endDate', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          billingType: 'monthly',
          amount: 1000,
          currency: 'USD',
          startDate: '2026-01-01',
          endDate: 'not-a-date',
        }),
      ),
    ).toThrow(ContractParseError);
  });

  it('throws for milestone type with no milestones', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          billingType: 'milestone',
          amount: 10000,
          currency: 'USD',
          startDate: '2026-01-01',
          milestones: [],
        }),
      ),
    ).toThrow(ContractParseError);
  });

  it('throws for hybrid type with no hybridSchedules', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          billingType: 'hybrid',
          amount: 10000,
          currency: 'USD',
          startDate: '2026-01-01',
          hybridSchedules: [],
        }),
      ),
    ).toThrow(ContractParseError);
  });

  it('throws for milestone missing required name', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          billingType: 'milestone',
          amount: 5000,
          currency: 'USD',
          startDate: '2026-01-01',
          milestones: [
            { amount: 5000, dueDate: '2026-06-01' }, // missing name
          ],
        }),
      ),
    ).toThrow(ContractParseError);
  });

  it('throws for milestone with invalid dueDate', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          billingType: 'milestone',
          amount: 5000,
          currency: 'USD',
          startDate: '2026-01-01',
          milestones: [
            { name: 'Phase 1', amount: 5000, dueDate: 'bad-date' },
          ],
        }),
      ),
    ).toThrow(ContractParseError);
  });

  it('throws for hybridSchedule with invalid billingType', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          billingType: 'hybrid',
          amount: 10000,
          currency: 'USD',
          startDate: '2026-01-01',
          hybridSchedules: [
            { billingType: 'hybrid', amount: 5000, startDate: '2026-01-01' }, // 'hybrid' not allowed in sub-schedule
          ],
        }),
      ),
    ).toThrow(ContractParseError);
  });

  it('throws on non-object root', () => {
    expect(() => parseAndValidate('"just a string"')).toThrow(ContractParseError);
  });
});

// ─── Error class ──────────────────────────────────────────────────────────────

describe('ContractParseError', () => {
  it('has correct name', () => {
    const err = new ContractParseError('test');
    expect(err.name).toBe('ContractParseError');
    expect(err instanceof Error).toBe(true);
  });
});
