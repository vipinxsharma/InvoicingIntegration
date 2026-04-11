/**
 * Invoice Generator
 *
 * Orchestrates the full pipeline for a single billing event:
 *   1.  Load schedule (and optional milestone)
 *   2.  Compute billing period via rules engine
 *   3.  Idempotency check – bail if invoice already exists
 *   4.  Fetch Bitrix24 deal / contact / company
 *   5.  Find or create LEDGERS contact (with entity mapping cache)
 *   6.  Build and POST LEDGERS invoice
 *   7.  Persist invoice_record + entity_mapping
 *   8.  Write LEDGERS invoice ID back to Bitrix24 deal
 *   9.  Write audit log
 *  10.  On any failure → enqueue for retry
 */

import { PoolClient } from 'pg';
import { config } from '../../config';
import { pool, withTransaction, queryOne } from '../../db/client';
import { bitrixClient } from '../bitrix/api-client';
import { ledgersClient } from '../ledgers/api-client';
import { auditLogger } from '../audit/logger';
import { enqueueError } from '../queue/error-queue';
import {
  calculateDuePeriod,
  isMilestoneDue,
  buildIdempotencyKey,
  toDateString,
  parseDate,
} from './rules-engine';
import type {
  BillingSchedule,
  BillingMilestone,
  InvoiceRecord,
  InvoiceGenerationResult,
  EntityMapping,
} from '../../types/billing';
import type { LedgersContactCreate, LedgersInvoiceCreate } from '../../types/ledgers';
import type { BitrixContact, BitrixCompany } from '../../types/bitrix';
import { logger } from '../audit/logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function extractEmail(
  entries: Array<{ VALUE: string }> | undefined,
): string {
  return entries?.[0]?.VALUE ?? '';
}

function extractPhone(
  entries: Array<{ VALUE: string }> | undefined,
): string | undefined {
  return entries?.[0]?.VALUE;
}

// ─── DB row → domain type mapper ─────────────────────────────────────────────

function mapInvoiceRecordRow(row: Record<string, unknown>): InvoiceRecord {
  return {
    id: row['id'] as string,
    scheduleId: row['schedule_id'] as string,
    milestoneId: (row['milestone_id'] as string | null) ?? undefined,
    bitrixDealId: row['bitrix_deal_id'] as string,
    ledgersInvoiceId: (row['ledgers_invoice_id'] as string | null) ?? undefined,
    ledgersInvoiceNumber:
      (row['ledgers_invoice_number'] as string | null) ?? undefined,
    idempotencyKey: row['idempotency_key'] as string,
    periodStart: row['period_start'] as Date,
    periodEnd: row['period_end'] as Date,
    amount: parseFloat(String(row['amount'])),
    currency: row['currency'] as string,
    status: row['status'] as InvoiceRecord['status'],
    errorMessage: (row['error_message'] as string | null) ?? undefined,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  };
}

// ─── Schedule loader ──────────────────────────────────────────────────────────

async function loadSchedule(scheduleId: string): Promise<BillingSchedule> {
  const row = await queryOne<{
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
    `SELECT * FROM billing_schedules WHERE id = $1`,
    [scheduleId],
  );

  if (!row) throw new Error(`Schedule ${scheduleId} not found`);
  if (!row.is_active) throw new Error(`Schedule ${scheduleId} is inactive`);

  return {
    id: row.id,
    contractId: row.contract_id,
    bitrixDealId: row.bitrix_deal_id,
    billingType: row.billing_type as BillingSchedule['billingType'],
    amount: parseFloat(row.amount),
    currency: row.currency,
    startDate: row.start_date,
    endDate: row.end_date ?? undefined,
    dayOfMonth: row.day_of_month ?? undefined,
    isActive: row.is_active,
    metadata: row.metadata ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadMilestone(milestoneId: string): Promise<BillingMilestone> {
  const row = await queryOne<{
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
    `SELECT * FROM billing_milestones WHERE id = $1`,
    [milestoneId],
  );

  if (!row) throw new Error(`Milestone ${milestoneId} not found`);

  return {
    id: row.id,
    scheduleId: row.schedule_id,
    name: row.name,
    amount: parseFloat(row.amount),
    dueDate: row.due_date,
    description: row.description ?? undefined,
    isBilled: row.is_billed,
    billedAt: row.billed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── LEDGERS contact resolution ───────────────────────────────────────────────

async function resolveOrCreateLedgersContact(
  client: PoolClient,
  bitrixDealId: string,
  bitrixContact: BitrixContact | null,
  bitrixCompany: BitrixCompany | null,
  currency: string,
): Promise<string> {
  // Check entity_mappings cache first
  const entityType = bitrixCompany ? 'company' : 'contact';
  const entityId = bitrixCompany ? bitrixCompany.ID : bitrixContact?.ID ?? '';

  const cached = await client.query<EntityMapping>(
    `SELECT ledgers_entity_id FROM entity_mappings
     WHERE bitrix_entity_type = $1
       AND bitrix_entity_id    = $2
       AND ledgers_entity_type = 'contact'`,
    [entityType, entityId],
  );

  if ((cached.rows[0] as EntityMapping | undefined)?.ledgersEntityId) {
    return (cached.rows[0] as EntityMapping).ledgersEntityId;
  }

  // Build LEDGERS contact payload
  const contactPayload: LedgersContactCreate = buildLedgersContact(
    bitrixContact,
    bitrixCompany,
    currency,
    entityId,
  );

  const ledgersContact = await ledgersClient.findOrCreateContact(contactPayload);

  // Persist mapping
  await client.query(
    `INSERT INTO entity_mappings
       (bitrix_entity_type, bitrix_entity_id, ledgers_entity_type, ledgers_entity_id)
     VALUES ($1,$2,'contact',$3)
     ON CONFLICT (bitrix_entity_type, bitrix_entity_id, ledgers_entity_type)
     DO UPDATE SET ledgers_entity_id = EXCLUDED.ledgers_entity_id, updated_at = NOW()`,
    [entityType, entityId, ledgersContact.id],
  );

  return ledgersContact.id;
}

function buildLedgersContact(
  contact: BitrixContact | null,
  company: BitrixCompany | null,
  currency: string,
  externalRef: string,
): LedgersContactCreate {
  if (company) {
    return {
      name: company.TITLE,
      email: extractEmail(company.EMAIL),
      phone: extractPhone(company.PHONE),
      currency,
      externalReference: `company:${externalRef}`,
      ...(company.ADDRESS
        ? {
            address: {
              line1: company.ADDRESS,
              city: company.ADDRESS_CITY ?? '',
              state: company.ADDRESS_STATE,
              country: company.ADDRESS_COUNTRY ?? '',
              postalCode: company.ADDRESS_POSTAL_CODE ?? '',
            },
          }
        : {}),
      ...(company.UF_CRN ? { taxId: company.UF_CRN } : {}),
    };
  }

  const name = contact
    ? `${contact.NAME ?? ''} ${contact.LAST_NAME ?? ''}`.trim()
    : 'Unknown';

  return {
    name,
    email: extractEmail(contact?.EMAIL),
    phone: extractPhone(contact?.PHONE),
    currency,
    externalReference: `contact:${externalRef}`,
    ...(contact?.ADDRESS
      ? {
          address: {
            line1: contact.ADDRESS,
            city: contact.ADDRESS_CITY ?? '',
            state: contact.ADDRESS_STATE,
            country: contact.ADDRESS_COUNTRY ?? '',
            postalCode: contact.ADDRESS_POSTAL_CODE ?? '',
          },
        }
      : {}),
  };
}

// ─── Invoice payload builder ──────────────────────────────────────────────────

function buildLedgersInvoice(
  ledgersContactId: string,
  schedule: BillingSchedule,
  period: { periodStart: Date; periodEnd: Date; amount: number; currency: string },
  milestone: BillingMilestone | undefined,
  paymentTermsDays: number,
  bitrixDealId: string,
): LedgersInvoiceCreate {
  const issueDate = toDateString(new Date());
  const dueDate = toDateString(addDays(new Date(), paymentTermsDays));

  const description = milestone
    ? `${milestone.name} – ${milestone.description ?? schedule.billingType}`
    : `${periodLabel(schedule.billingType)} – ${toDateString(period.periodStart)} to ${toDateString(period.periodEnd)}`;

  return {
    contactId: ledgersContactId,
    issueDate,
    dueDate,
    currency: period.currency,
    referenceNumber: `BTRX-${bitrixDealId}`,
    notes: `Billing period: ${toDateString(period.periodStart)} to ${toDateString(period.periodEnd)}`,
    lineItems: [
      {
        description,
        quantity: 1,
        unitPrice: period.amount,
        taxRate: 0,
      },
    ],
    customFields: {
      bitrixDealId,
      scheduleId: schedule.id,
      ...(milestone ? { milestoneId: milestone.id } : {}),
    },
  };
}

function periodLabel(type: string): string {
  const labels: Record<string, string> = {
    monthly: 'Monthly Service',
    quarterly: 'Quarterly Service',
    annual: 'Annual Service',
    one_time: 'One-Time Payment',
    milestone: 'Milestone Payment',
  };
  return labels[type] ?? 'Service';
}

// ─── Main generator ───────────────────────────────────────────────────────────

/**
 * Generate a LEDGERS invoice for a billing schedule on a given date.
 * Idempotent: returns existing record without calling LEDGERS again if already created.
 */
export async function generateInvoice(
  scheduleId: string,
  asOf: Date = new Date(),
): Promise<InvoiceGenerationResult> {
  const schedule = await loadSchedule(scheduleId);
  const period = calculateDuePeriod(schedule, asOf);

  if (!period) {
    throw new InvoiceGenerationError(
      `No invoice due for schedule ${scheduleId} on ${toDateString(asOf)}`,
    );
  }

  return generateInvoiceForPeriod(schedule, period, undefined, asOf);
}

/**
 * Generate a LEDGERS invoice for a specific milestone.
 */
export async function generateMilestoneInvoice(
  scheduleId: string,
  milestoneId: string,
  asOf: Date = new Date(),
): Promise<InvoiceGenerationResult> {
  const [schedule, milestone] = await Promise.all([
    loadSchedule(scheduleId),
    loadMilestone(milestoneId),
  ]);

  if (!isMilestoneDue(milestone, asOf)) {
    throw new InvoiceGenerationError(
      `Milestone ${milestoneId} is not yet due or already billed`,
    );
  }

  const period = {
    periodStart: parseDate(toDateString(milestone.dueDate)),
    periodEnd: parseDate(toDateString(milestone.dueDate)),
    idempotencyKey: buildIdempotencyKey(
      scheduleId,
      'milestone',
      milestone.dueDate,
      milestone.dueDate,
    ),
    amount: milestone.amount,
    currency: schedule.currency,
  };

  return generateInvoiceForPeriod(schedule, period, milestone, asOf);
}

async function generateInvoiceForPeriod(
  schedule: BillingSchedule,
  period: {
    periodStart: Date;
    periodEnd: Date;
    idempotencyKey: string;
    amount: number;
    currency: string;
  },
  milestone: BillingMilestone | undefined,
  _asOf: Date,
): Promise<InvoiceGenerationResult> {
  // ── 1. Idempotency check ──────────────────────────────────────────────────
  const existing = await queryOne<InvoiceRecord>(
    `SELECT * FROM invoice_records WHERE idempotency_key = $1`,
    [period.idempotencyKey],
  );

  if (existing) {
    logger.info('Invoice already exists – skipping', {
      idempotencyKey: period.idempotencyKey,
      ledgersInvoiceId: existing.ledgersInvoiceId,
    });
    return { invoiceRecord: existing, isNew: false, isDuplicate: true };
  }

  // ── 2. Fetch Bitrix24 entities ────────────────────────────────────────────
  const deal = await bitrixClient.getDeal(schedule.bitrixDealId);

  const [bitrixContact, bitrixCompany] = await Promise.all([
    deal.CONTACT_ID
      ? bitrixClient.getContact(deal.CONTACT_ID).catch(() => null)
      : null,
    deal.COMPANY_ID
      ? bitrixClient.getCompany(deal.COMPANY_ID).catch(() => null)
      : null,
  ]);

  const paymentTermsDays: number =
    (schedule.metadata?.['paymentTermsDays'] as number | undefined) ?? 30;

  // ── 3 – 8. Transactional: create contact, invoice, store records ──────────
  let invoiceRecord!: InvoiceRecord;

  try {
    invoiceRecord = await withTransaction(async (client) => {
      // 3. Resolve LEDGERS contact
      const ledgersContactId = await resolveOrCreateLedgersContact(
        client,
        schedule.bitrixDealId,
        bitrixContact,
        bitrixCompany,
        period.currency,
      );

      // 4. Insert a pending invoice_record to claim the idempotency key
      const pending = await client.query<{ id: string }>(
        `INSERT INTO invoice_records
           (schedule_id, milestone_id, bitrix_deal_id, idempotency_key,
            period_start, period_end, amount, currency, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
         RETURNING id`,
        [
          schedule.id,
          milestone?.id ?? null,
          schedule.bitrixDealId,
          period.idempotencyKey,
          toDateString(period.periodStart),
          toDateString(period.periodEnd),
          period.amount,
          period.currency,
        ],
      );

      const invoiceRecordId = pending.rows[0]?.id;
      if (!invoiceRecordId) throw new Error('Failed to insert invoice record');

      // 5. Call LEDGERS
      const invoicePayload = buildLedgersInvoice(
        ledgersContactId,
        schedule,
        period,
        milestone,
        paymentTermsDays,
        schedule.bitrixDealId,
      );

      const ledgersInvoice = await ledgersClient.createInvoice(invoicePayload);

      // 6. Persist entity mapping for invoice
      await client.query(
        `INSERT INTO entity_mappings
           (bitrix_entity_type, bitrix_entity_id, ledgers_entity_type, ledgers_entity_id,
            metadata)
         VALUES ('deal',$1,'invoice',$2,$3)
         ON CONFLICT (bitrix_entity_type, bitrix_entity_id, ledgers_entity_type)
         DO UPDATE SET ledgers_entity_id = EXCLUDED.ledgers_entity_id, updated_at = NOW()`,
        [
          schedule.bitrixDealId,
          ledgersInvoice.id,
          JSON.stringify({ invoiceNumber: ledgersInvoice.invoiceNumber }),
        ],
      );

      // 7. Update invoice_record to 'created'
      const updatedRecord = await client.query<Record<string, unknown>>(
        `UPDATE invoice_records
         SET status = 'created',
             ledgers_invoice_id = $2,
             ledgers_invoice_number = $3,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [invoiceRecordId, ledgersInvoice.id, ledgersInvoice.invoiceNumber],
      );

      // 8. Mark milestone as billed (within transaction)
      if (milestone) {
        await client.query(
          `UPDATE billing_milestones
           SET is_billed = TRUE, billed_at = NOW()
           WHERE id = $1`,
          [milestone.id],
        );
      }

      return mapInvoiceRecordRow(updatedRecord.rows[0] as Record<string, unknown>);
    });

    // ── 9. Write back to Bitrix24 (outside transaction – network call) ──────
    try {
      await bitrixClient.appendLedgersInvoiceId(
        schedule.bitrixDealId,
        invoiceRecord.ledgersInvoiceId!,
      );
    } catch (err) {
      logger.warn('Failed to write back LEDGERS invoice ID to Bitrix24', {
        dealId: schedule.bitrixDealId,
        ledgersInvoiceId: invoiceRecord.ledgersInvoiceId,
        err,
      });
      // Non-fatal: invoice is already created
    }

    // ── 10. Audit log ────────────────────────────────────────────────────────
    await auditLogger.log({
      eventType: 'INVOICE_CREATED',
      entityType: 'invoice',
      entityId: invoiceRecord.ledgersInvoiceId,
      bitrixDealId: schedule.bitrixDealId,
      ledgersInvoiceId: invoiceRecord.ledgersInvoiceId,
      result: {
        invoiceRecordId: invoiceRecord.id,
        amount: period.amount,
        currency: period.currency,
        period: `${toDateString(period.periodStart)} – ${toDateString(period.periodEnd)}`,
      },
      success: true,
    });

    return { invoiceRecord, isNew: true, isDuplicate: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    logger.error('Invoice generation failed', {
      scheduleId: schedule.id,
      error: message,
    });

    await auditLogger.log({
      eventType: 'INVOICE_FAILED',
      entityType: 'schedule',
      entityId: schedule.id,
      bitrixDealId: schedule.bitrixDealId,
      payload: { idempotencyKey: period.idempotencyKey },
      success: false,
      errorMessage: message,
    });

    // Mark any pending record as failed
    await pool.query(
      `UPDATE invoice_records
       SET status = 'failed', error_message = $2, updated_at = NOW()
       WHERE idempotency_key = $1 AND status = 'pending'`,
      [period.idempotencyKey, message],
    );

    // Enqueue for retry
    await enqueueError({
      scheduleId: schedule.id,
      errorType: error?.constructor?.name ?? 'Error',
      errorMessage: message,
      errorStack: stack,
      context: {
        billingType: schedule.billingType,
        dealId: schedule.bitrixDealId,
        periodStart: toDateString(period.periodStart),
        periodEnd: toDateString(period.periodEnd),
        milestoneId: milestone?.id,
      },
    });

    throw new InvoiceGenerationError(message);
  }
}

export class InvoiceGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceGenerationError';
  }
}
