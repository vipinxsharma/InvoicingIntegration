/**
 * Admin REST API
 *
 * All routes require X-Admin-Api-Key header (enforced by middleware).
 *
 * GET  /admin/schedules
 * GET  /admin/schedules/:id
 * POST /admin/schedules/:id/pause
 * POST /admin/schedules/:id/resume
 * GET  /admin/invoices
 * POST /admin/invoices/:id/retry
 * GET  /admin/errors
 * POST /admin/errors/:id/retry
 * POST /admin/errors/:id/resolve
 * GET  /admin/contracts
 * POST /admin/contracts
 * GET  /admin/audit
 */

import { Router, Request, Response, NextFunction } from 'express';
import { pool, queryOne } from '../db/client';
import { generateInvoice } from '../modules/billing/invoice-generator';
import { listErrorQueue, markResolved, getErrorQueueEntry } from '../modules/queue/error-queue';
import { auditLogger } from '../modules/audit/logger';
import { parseContractTerms } from '../modules/contract/parser';
import { createSchedulesFromTerms } from '../modules/billing/rules-engine';
import { toDateString } from '../modules/billing/rules-engine';
import type { BillingSchedule, InvoiceRecord } from '../types/billing';

const router = Router();

function asyncWrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

function paginationParams(query: Record<string, unknown>): {
  limit: number;
  offset: number;
  page: number;
} {
  const page = Math.max(1, parseInt(String(query['page'] ?? '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(query['limit'] ?? '50'), 10)));
  return { limit, offset: (page - 1) * limit, page };
}

// ─── Schedules ────────────────────────────────────────────────────────────────

router.get(
  '/schedules',
  asyncWrap(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (req.query['dealId']) {
      conditions.push(`bitrix_deal_id = $${idx++}`);
      params.push(req.query['dealId']);
    }
    if (req.query['status'] === 'active') {
      conditions.push(`is_active = TRUE`);
    } else if (req.query['status'] === 'inactive') {
      conditions.push(`is_active = FALSE`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [countRes, rowRes] = await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM billing_schedules ${where}`,
        params,
      ),
      pool.query(
        `SELECT * FROM billing_schedules ${where}
         ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      ),
    ]);

    res.json({
      data: rowRes.rows,
      total: parseInt(countRes.rows[0]?.count ?? '0', 10),
    });
  }),
);

router.get(
  '/schedules/:id',
  asyncWrap(async (req, res) => {
    const schedule = await queryOne(
      `SELECT bs.*, c.parsed_terms AS contract_terms
       FROM billing_schedules bs
       JOIN contracts c ON c.id = bs.contract_id
       WHERE bs.id = $1`,
      [req.params['id']],
    );
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json(schedule);
  }),
);

router.post(
  '/schedules/:id/pause',
  asyncWrap(async (req, res) => {
    await pool.query(
      `UPDATE billing_schedules SET is_active = FALSE WHERE id = $1`,
      [req.params['id']],
    );
    res.json({ success: true });
  }),
);

router.post(
  '/schedules/:id/resume',
  asyncWrap(async (req, res) => {
    await pool.query(
      `UPDATE billing_schedules SET is_active = TRUE WHERE id = $1`,
      [req.params['id']],
    );
    res.json({ success: true });
  }),
);

// ─── Milestones ───────────────────────────────────────────────────────────────

router.get(
  '/schedules/:id/milestones',
  asyncWrap(async (req, res) => {
    const rows = await pool.query(
      `SELECT * FROM billing_milestones WHERE schedule_id = $1 ORDER BY due_date`,
      [req.params['id']],
    );
    res.json({ data: rows.rows });
  }),
);

// ─── Invoices ─────────────────────────────────────────────────────────────────

router.get(
  '/invoices',
  asyncWrap(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (req.query['dealId']) {
      conditions.push(`bitrix_deal_id = $${idx++}`);
      params.push(req.query['dealId']);
    }
    if (req.query['status']) {
      conditions.push(`status = $${idx++}`);
      params.push(req.query['status']);
    }
    if (req.query['from']) {
      conditions.push(`period_start >= $${idx++}`);
      params.push(req.query['from']);
    }
    if (req.query['to']) {
      conditions.push(`period_end <= $${idx++}`);
      params.push(req.query['to']);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [countRes, rowRes] = await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM invoice_records ${where}`,
        params,
      ),
      pool.query(
        `SELECT * FROM invoice_records ${where}
         ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      ),
    ]);

    res.json({
      data: rowRes.rows,
      total: parseInt(countRes.rows[0]?.count ?? '0', 10),
    });
  }),
);

router.post(
  '/invoices/:id/retry',
  asyncWrap(async (req, res) => {
    const record = await queryOne<InvoiceRecord>(
      `SELECT * FROM invoice_records WHERE id = $1`,
      [req.params['id']],
    );
    if (!record) {
      res.status(404).json({ error: 'Invoice record not found' });
      return;
    }
    if (record.status === 'created') {
      res.status(409).json({ error: 'Invoice already created successfully' });
      return;
    }

    const result = await generateInvoice(
      record.scheduleId,
      record.periodStart,
    );
    res.json({ success: true, invoiceRecord: result.invoiceRecord });
  }),
);

// ─── Error queue ──────────────────────────────────────────────────────────────

router.get(
  '/errors',
  asyncWrap(async (req, res) => {
    const { page, limit } = paginationParams(req.query);
    const result = await listErrorQueue({
      status: req.query['status'] as string | undefined as any,
      page,
      limit,
    });
    res.json(result);
  }),
);

router.post(
  '/errors/:id/retry',
  asyncWrap(async (req, res) => {
    const entry = await getErrorQueueEntry(req.params['id']!);
    if (!entry) {
      res.status(404).json({ error: 'Error queue entry not found' });
      return;
    }

    const asOf = new Date();
    const context = entry.context ?? {};
    const milestoneId = context['milestoneId'] as string | undefined;

    let result;
    if (milestoneId) {
      const { generateMilestoneInvoice } = await import(
        '../modules/billing/invoice-generator'
      );
      result = await generateMilestoneInvoice(entry.scheduleId, milestoneId, asOf);
    } else {
      result = await generateInvoice(entry.scheduleId, asOf);
    }

    await markResolved(entry.id);
    res.json({ success: true, invoiceRecord: result.invoiceRecord });
  }),
);

router.post(
  '/errors/:id/resolve',
  asyncWrap(async (req, res) => {
    const entry = await getErrorQueueEntry(req.params['id']!);
    if (!entry) {
      res.status(404).json({ error: 'Error queue entry not found' });
      return;
    }
    await markResolved(entry.id);
    res.json({ success: true });
  }),
);

// ─── Contracts ────────────────────────────────────────────────────────────────

router.get(
  '/contracts',
  asyncWrap(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);
    const rows = await pool.query(
      `SELECT * FROM contracts ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    res.json({ data: rows.rows });
  }),
);

router.post(
  '/contracts',
  asyncWrap(async (req, res) => {
    const { bitrixDealId, contractText } = req.body as {
      bitrixDealId?: string;
      contractText?: string;
    };

    if (!bitrixDealId || !contractText) {
      res.status(400).json({ error: 'bitrixDealId and contractText are required' });
      return;
    }

    const terms = await parseContractTerms(contractText);

    const contractRow = await queryOne<{ id: string }>(
      `INSERT INTO contracts (bitrix_deal_id, raw_text, parsed_terms, status)
       VALUES ($1,$2,$3,'active')
       ON CONFLICT (bitrix_deal_id) DO UPDATE
         SET raw_text = EXCLUDED.raw_text,
             parsed_terms = EXCLUDED.parsed_terms,
             updated_at = NOW()
       RETURNING id`,
      [bitrixDealId, contractText, JSON.stringify(terms)],
    );

    const contractId = contractRow?.id;
    if (!contractId) throw new Error('Failed to upsert contract');

    // Deactivate old schedules
    await pool.query(
      `UPDATE billing_schedules SET is_active = FALSE WHERE contract_id = $1`,
      [contractId],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await createSchedulesFromTerms(contractId, bitrixDealId, terms, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ contractId, terms });
  }),
);

// ─── Audit logs ───────────────────────────────────────────────────────────────

router.get(
  '/audit',
  asyncWrap(async (req, res) => {
    const { page, limit } = paginationParams(req.query);
    const result = await auditLogger.query({
      bitrixDealId: req.query['dealId'] as string | undefined,
      eventType: req.query['eventType'] as string | undefined,
      from: req.query['from'] ? new Date(String(req.query['from'])) : undefined,
      to: req.query['to'] ? new Date(String(req.query['to'])) : undefined,
      page,
      limit,
    });
    res.json(result);
  }),
);

export default router;
