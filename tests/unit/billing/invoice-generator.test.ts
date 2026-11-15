/**
 * Unit tests – Invoice Generator
 *
 * All external dependencies are mocked so the orchestration logic is tested
 * in complete isolation.
 *
 * Scenarios:
 *  - Successful invoice creation for a recurring schedule
 *  - Duplicate detection returns existing record without calling LEDGERS
 *  - Milestone invoice created and milestone marked as billed
 *  - Schedule not active → throws
 *  - LEDGERS API failure → enqueues for retry
 */

// ─── Module mocks (factory functions reference NO outer variables) ────────────
jest.mock('../../../src/db/client', () => ({
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
  pool: { query: jest.fn() },
}));

jest.mock('../../../src/modules/bitrix/api-client', () => ({
  bitrixClient: {
    getDeal: jest.fn(),
    getContact: jest.fn(),
    getCompany: jest.fn(),
    appendLedgersInvoiceId: jest.fn(),
  },
}));

jest.mock('../../../src/modules/ledgers/api-client', () => ({
  ledgersClient: {
    findOrCreateContact: jest.fn(),
    createInvoice: jest.fn(),
  },
}));

jest.mock('../../../src/modules/audit/logger', () => ({
  auditLogger: { log: jest.fn() },
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../src/modules/queue/error-queue', () => ({
  enqueueError: jest.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { generateInvoice, generateMilestoneInvoice } from '../../../src/modules/billing/invoice-generator';
import { parseDate } from '../../../src/modules/billing/rules-engine';
import type { InvoiceRecord } from '../../../src/types/billing';

// Typed references to mocked modules
import * as dbClient from '../../../src/db/client';
import { bitrixClient } from '../../../src/modules/bitrix/api-client';
import { ledgersClient } from '../../../src/modules/ledgers/api-client';
import { auditLogger } from '../../../src/modules/audit/logger';
import { enqueueError } from '../../../src/modules/queue/error-queue';

const mockQueryOne = dbClient.queryOne as jest.Mock;
const mockWithTransaction = dbClient.withTransaction as jest.Mock;
const mockPoolQuery = (dbClient.pool as unknown as { query: jest.Mock }).query;

const mockGetDeal = bitrixClient.getDeal as jest.Mock;
const mockGetContact = bitrixClient.getContact as jest.Mock;
const mockGetCompany = bitrixClient.getCompany as jest.Mock;
const mockAppendInvoiceId = bitrixClient.appendLedgersInvoiceId as jest.Mock;

const mockFindOrCreate = ledgersClient.findOrCreateContact as jest.Mock;
const mockCreateInvoice = ledgersClient.createInvoice as jest.Mock;

const mockAuditLog = auditLogger.log as jest.Mock;
const mockEnqueueError = enqueueError as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCHEDULE_ID = 'sched-test-001';
const MILESTONE_ID = 'ms-test-001';
const DEAL_ID = 'deal-test-001';

const baseScheduleRow = {
  id: SCHEDULE_ID,
  contract_id: 'contract-001',
  bitrix_deal_id: DEAL_ID,
  billing_type: 'monthly',
  amount: '1000.00',
  currency: 'USD',
  start_date: parseDate('2026-01-01'),
  end_date: null,
  day_of_month: 1,
  is_active: true,
  metadata: { paymentTermsDays: 30 },
  created_at: new Date(),
  updated_at: new Date(),
};

const baseMilestoneRow = {
  id: MILESTONE_ID,
  schedule_id: SCHEDULE_ID,
  name: 'Project Kickoff',
  amount: '2500.00',
  due_date: parseDate('2026-03-01'),
  description: 'Initial milestone',
  is_billed: false,
  billed_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};

const bitrixDeal = {
  ID: DEAL_ID,
  TITLE: 'Test Deal',
  COMPANY_ID: 'company-001',
  CONTACT_ID: 'contact-001',
  OPPORTUNITY: '12000',
  CURRENCY_ID: 'USD',
};

const bitrixContact = {
  ID: 'contact-001',
  NAME: 'Alice',
  LAST_NAME: 'Smith',
  EMAIL: [{ VALUE: 'alice@example.com', VALUE_TYPE: 'WORK' }],
  PHONE: [{ VALUE: '+1234567890', VALUE_TYPE: 'WORK' }],
  COMPANY_ID: 'company-001',
};

const ledgersContactFixture = {
  id: 'ledgers-contact-001',
  name: 'Alice Smith',
  email: 'alice@example.com',
  currency: 'USD',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const ledgersInvoiceFixture = {
  id: 'ledgers-inv-001',
  invoiceNumber: 'INV-2026-0001',
  status: 'draft',
  contactId: 'ledgers-contact-001',
  lineItems: [],
  subtotal: 1000,
  taxTotal: 0,
  total: 1000,
  currency: 'USD',
  issueDate: '2026-01-01',
  dueDate: '2026-01-31',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupSuccessfulTransaction(invoiceRecordId = 'inv-record-001'): void {
  mockWithTransaction.mockImplementation(
    async (cb: (c: Record<string, unknown>) => Promise<unknown>) => {
      const fakeClient = {
        query: jest.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('INSERT INTO invoice_records')) {
            return { rows: [{ id: invoiceRecordId }] };
          }
          if (sql.includes("SET status = 'created'")) {
            return {
              rows: [{
                id: invoiceRecordId,
                schedule_id: SCHEDULE_ID,
                milestone_id: null,
                bitrix_deal_id: DEAL_ID,
                ledgers_invoice_id: ledgersInvoiceFixture.id,
                ledgers_invoice_number: ledgersInvoiceFixture.invoiceNumber,
                idempotency_key: 'key',
                period_start: parseDate('2026-01-01'),
                period_end: parseDate('2026-01-31'),
                amount: '1000.00',
                currency: 'USD',
                status: 'created',
                error_message: null,
                created_at: new Date(),
                updated_at: new Date(),
              }],
            };
          }
          // SELECT entity_mappings cache lookup
          if (sql.includes('SELECT ledgers_entity_id')) {
            return { rows: [] };
          }
          return { rows: [] };
        }),
      };
      return cb(fakeClient);
    },
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockPoolQuery.mockResolvedValue({ rows: [] });
  mockAppendInvoiceId.mockResolvedValue(undefined);
  mockAuditLog.mockResolvedValue(undefined);
  mockEnqueueError.mockResolvedValue(undefined);
});

// ─── Recurring (monthly) ─────────────────────────────────────────────────────

describe('generateInvoice – recurring (monthly)', () => {
  it('creates a new invoice when none exists', async () => {
    mockQueryOne
      .mockResolvedValueOnce(baseScheduleRow) // loadSchedule
      .mockResolvedValueOnce(null);            // idempotency check → no existing

    mockGetDeal.mockResolvedValue(bitrixDeal);
    mockGetContact.mockResolvedValue(bitrixContact);
    mockGetCompany.mockResolvedValue(null);
    mockFindOrCreate.mockResolvedValue(ledgersContactFixture);
    mockCreateInvoice.mockResolvedValue(ledgersInvoiceFixture);

    setupSuccessfulTransaction();

    const result = await generateInvoice(SCHEDULE_ID, parseDate('2026-01-01'));

    expect(result.isNew).toBe(true);
    expect(result.isDuplicate).toBe(false);
    expect(result.invoiceRecord.status).toBe('created');
    expect(result.invoiceRecord.ledgersInvoiceId).toBe(ledgersInvoiceFixture.id);
    expect(mockCreateInvoice).toHaveBeenCalledTimes(1);
    expect(mockAppendInvoiceId).toHaveBeenCalledWith(DEAL_ID, ledgersInvoiceFixture.id);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'INVOICE_CREATED', success: true }),
    );
  });

  it('returns existing record without calling LEDGERS when duplicate detected', async () => {
    const existingRecord: Partial<InvoiceRecord> = {
      id: 'existing-inv-001',
      scheduleId: SCHEDULE_ID,
      ledgersInvoiceId: 'ledgers-inv-existing',
      status: 'created',
    };

    mockQueryOne
      .mockResolvedValueOnce(baseScheduleRow) // loadSchedule
      .mockResolvedValueOnce(existingRecord); // idempotency check → found

    const result = await generateInvoice(SCHEDULE_ID, parseDate('2026-01-01'));

    expect(result.isDuplicate).toBe(true);
    expect(result.isNew).toBe(false);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  it('throws when no invoice is due on the given date', async () => {
    mockQueryOne.mockResolvedValueOnce({
      ...baseScheduleRow,
      billing_type: 'monthly',
      start_date: parseDate('2026-01-01'),
      day_of_month: 1,
    });

    // 15th is not the billing day
    await expect(
      generateInvoice(SCHEDULE_ID, parseDate('2026-01-15')),
    ).rejects.toThrow('No invoice due');
  });

  it('throws when the schedule is inactive', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...baseScheduleRow, is_active: false });

    await expect(
      generateInvoice(SCHEDULE_ID, parseDate('2026-01-01')),
    ).rejects.toThrow('inactive');
  });
});

// ─── Milestone invoice ────────────────────────────────────────────────────────

describe('generateMilestoneInvoice', () => {
  it('creates an invoice for a due milestone', async () => {
    mockQueryOne
      .mockResolvedValueOnce(baseScheduleRow)  // loadSchedule
      .mockResolvedValueOnce(baseMilestoneRow) // loadMilestone
      .mockResolvedValueOnce(null);             // idempotency

    mockGetDeal.mockResolvedValue(bitrixDeal);
    mockGetContact.mockResolvedValue(bitrixContact);
    mockGetCompany.mockResolvedValue(null);
    mockFindOrCreate.mockResolvedValue(ledgersContactFixture);
    mockCreateInvoice.mockResolvedValue(ledgersInvoiceFixture);

    setupSuccessfulTransaction('inv-ms-001');

    const result = await generateMilestoneInvoice(
      SCHEDULE_ID,
      MILESTONE_ID,
      parseDate('2026-03-01'),
    );

    expect(result.isNew).toBe(true);
    expect(result.isDuplicate).toBe(false);
    expect(mockCreateInvoice).toHaveBeenCalledTimes(1);
  });

  it('throws when milestone is already billed', async () => {
    mockQueryOne
      .mockResolvedValueOnce(baseScheduleRow)
      .mockResolvedValueOnce({ ...baseMilestoneRow, is_billed: true, billed_at: new Date() });

    await expect(
      generateMilestoneInvoice(SCHEDULE_ID, MILESTONE_ID, parseDate('2026-03-01')),
    ).rejects.toThrow('not yet due or already billed');
  });

  it('throws when milestone is not yet due', async () => {
    mockQueryOne
      .mockResolvedValueOnce(baseScheduleRow)
      .mockResolvedValueOnce({
        ...baseMilestoneRow,
        due_date: parseDate('2026-06-01'), // future date
        is_billed: false,
      });

    await expect(
      generateMilestoneInvoice(SCHEDULE_ID, MILESTONE_ID, parseDate('2026-03-01')),
    ).rejects.toThrow('not yet due or already billed');
  });
});

// ─── Error handling / retry queue ─────────────────────────────────────────────

describe('generateInvoice – error handling', () => {
  it('enqueues error and emits audit log when LEDGERS API fails', async () => {
    mockQueryOne
      .mockResolvedValueOnce(baseScheduleRow)
      .mockResolvedValueOnce(null);

    mockGetDeal.mockResolvedValue(bitrixDeal);
    mockGetContact.mockResolvedValue(bitrixContact);
    mockGetCompany.mockResolvedValue(null);
    mockFindOrCreate.mockResolvedValue(ledgersContactFixture);
    mockCreateInvoice.mockRejectedValue(new Error('LEDGERS API timeout'));

    mockWithTransaction.mockImplementation(
      async (cb: (c: Record<string, unknown>) => Promise<unknown>) => {
        const fakeClient = {
          query: jest.fn().mockImplementation(async (sql: string) => {
            if (sql.includes('INSERT INTO invoice_records')) {
              return { rows: [{ id: 'pending-rec-001' }] };
            }
            if (sql.includes('SELECT ledgers_entity_id')) {
              return { rows: [] };
            }
            return { rows: [] };
          }),
        };
        return cb(fakeClient);
      },
    );

    await expect(
      generateInvoice(SCHEDULE_ID, parseDate('2026-01-01')),
    ).rejects.toThrow('LEDGERS API timeout');

    expect(mockEnqueueError).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: SCHEDULE_ID,
        errorMessage: 'LEDGERS API timeout',
      }),
    );

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'INVOICE_FAILED', success: false }),
    );
  });
});
