import winston from 'winston';
import { pool } from '../../db/client';
import type { AuditLog } from '../../types/billing';

// ─── Winston structured logger ────────────────────────────────────────────────

export const logger = winston.createLogger({
  level: process.env['NODE_ENV'] === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env['NODE_ENV'] === 'production'
      ? winston.format.json()
      : winston.format.prettyPrint(),
  ),
  transports: [new winston.transports.Console()],
});

// ─── Database Audit Logger ─────────────────────────────────────────────────────

export interface AuditLogInput {
  eventType: string;
  entityType?: string;
  entityId?: string;
  bitrixDealId?: string;
  ledgersInvoiceId?: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  success: boolean;
  errorMessage?: string;
  ipAddress?: string;
}

class AuditLogger {
  async log(input: AuditLogInput): Promise<void> {
    const sql = `
      INSERT INTO audit_logs
        (event_type, entity_type, entity_id, bitrix_deal_id, ledgers_invoice_id,
         payload, result, success, error_message, ip_address)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `;
    const params = [
      input.eventType,
      input.entityType ?? null,
      input.entityId ?? null,
      input.bitrixDealId ?? null,
      input.ledgersInvoiceId ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
      input.result ? JSON.stringify(input.result) : null,
      input.success,
      input.errorMessage ?? null,
      input.ipAddress ?? null,
    ];

    try {
      await pool.query(sql, params);
    } catch (err) {
      // Audit log failures must never crash the main flow
      logger.error('Failed to write audit log', { err, input });
    }

    // Mirror to structured log
    const logFn = input.success ? logger.info.bind(logger) : logger.error.bind(logger);
    logFn(`[audit] ${input.eventType}`, {
      entityType: input.entityType,
      entityId: input.entityId,
      bitrixDealId: input.bitrixDealId,
      ledgersInvoiceId: input.ledgersInvoiceId,
      success: input.success,
      ...(input.errorMessage ? { error: input.errorMessage } : {}),
    });
  }

  async query(filter: {
    bitrixDealId?: string;
    eventType?: string;
    from?: Date;
    to?: Date;
    page?: number;
    limit?: number;
  }): Promise<{ rows: AuditLog[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter.bitrixDealId) {
      conditions.push(`bitrix_deal_id = $${idx++}`);
      params.push(filter.bitrixDealId);
    }
    if (filter.eventType) {
      conditions.push(`event_type = $${idx++}`);
      params.push(filter.eventType);
    }
    if (filter.from) {
      conditions.push(`created_at >= $${idx++}`);
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push(`created_at <= $${idx++}`);
      params.push(filter.to);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 50;
    const offset = ((filter.page ?? 1) - 1) * limit;

    const [countResult, rowResult] = await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM audit_logs ${where}`,
        params,
      ),
      pool.query<AuditLog>(
        `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      ),
    ]);

    return {
      rows: rowResult.rows,
      total: parseInt(countResult.rows[0]?.count ?? '0', 10),
    };
  }
}

export const auditLogger = new AuditLogger();
