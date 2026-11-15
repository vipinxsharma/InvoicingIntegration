/**
 * Error Queue
 *
 * Stores failed invoice generation attempts for later retry.
 * Uses exponential backoff: delay = baseDelayMs * 2^(attempts-1)
 */

import { pool, queryOne } from '../../db/client';
import { config } from '../../config';
import type { ErrorQueueEntry, ErrorQueueStatus } from '../../types/billing';
import { logger } from '../audit/logger';

// ─── Enqueue ──────────────────────────────────────────────────────────────────

export interface EnqueueErrorInput {
  scheduleId: string;
  invoiceRecordId?: string;
  errorType: string;
  errorMessage: string;
  errorStack?: string;
  context?: Record<string, unknown>;
}

export async function enqueueError(input: EnqueueErrorInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO error_queue
         (schedule_id, invoice_record_id, error_type, error_message, error_stack,
          context, max_attempts, next_retry_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [
        input.scheduleId,
        input.invoiceRecordId ?? null,
        input.errorType,
        input.errorMessage,
        input.errorStack ?? null,
        input.context ? JSON.stringify(input.context) : null,
        config.retry.maxAttempts,
      ],
    );
    logger.warn('[error-queue] Error enqueued for retry', {
      scheduleId: input.scheduleId,
      errorType: input.errorType,
    });
  } catch (err) {
    logger.error('[error-queue] Failed to enqueue error', { err, input });
  }
}

// ─── Fetch retryable items ────────────────────────────────────────────────────

export async function fetchRetryableItems(
  limit = 50,
): Promise<ErrorQueueEntry[]> {
  const result = await pool.query<{
    id: string;
    invoice_record_id: string | null;
    schedule_id: string;
    error_type: string;
    error_message: string;
    error_stack: string | null;
    context: Record<string, unknown> | null;
    attempts: number;
    max_attempts: number;
    next_retry_at: Date;
    resolved_at: Date | null;
    status: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT * FROM error_queue
     WHERE status IN ('pending','retrying')
       AND next_retry_at <= NOW()
       AND attempts < max_attempts
     ORDER BY next_retry_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );

  return result.rows.map((r) => ({
    id: r.id,
    invoiceRecordId: r.invoice_record_id ?? undefined,
    scheduleId: r.schedule_id,
    errorType: r.error_type,
    errorMessage: r.error_message,
    errorStack: r.error_stack ?? undefined,
    context: r.context ?? undefined,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    nextRetryAt: r.next_retry_at,
    resolvedAt: r.resolved_at ?? undefined,
    status: r.status as ErrorQueueStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// ─── Status updates ───────────────────────────────────────────────────────────

export async function markRetrying(id: string): Promise<void> {
  await pool.query(
    `UPDATE error_queue
     SET status = 'retrying', attempts = attempts + 1, updated_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

export async function markResolved(id: string): Promise<void> {
  await pool.query(
    `UPDATE error_queue
     SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

export async function markFailed(
  id: string,
  errorMessage: string,
): Promise<void> {
  await pool.query(
    `UPDATE error_queue
     SET status = 'dead_letter', error_message = $2, updated_at = NOW()
     WHERE id = $1`,
    [id, errorMessage],
  );
}

/**
 * Schedule the next retry using exponential backoff.
 * Delay = baseDelayMs * 2^(attempts - 1), capped at 24h.
 */
export async function scheduleNextRetry(
  id: string,
  attempts: number,
): Promise<void> {
  const base = config.retry.baseDelayMs;
  const delayMs = Math.min(base * Math.pow(2, attempts - 1), 86_400_000);
  await pool.query(
    `UPDATE error_queue
     SET status = 'pending',
         next_retry_at = NOW() + ($2 || ' milliseconds')::interval,
         updated_at = NOW()
     WHERE id = $1`,
    [id, delayMs],
  );
}

// ─── Admin queries ────────────────────────────────────────────────────────────

export async function listErrorQueue(filter: {
  status?: ErrorQueueStatus;
  page?: number;
  limit?: number;
}): Promise<{ rows: ErrorQueueEntry[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filter.status) {
    conditions.push(`status = $${idx++}`);
    params.push(filter.status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filter.limit ?? 50;
  const offset = ((filter.page ?? 1) - 1) * limit;

  const [countResult, rowResult] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM error_queue ${where}`,
      params,
    ),
    pool.query<ErrorQueueEntry>(
      `SELECT * FROM error_queue ${where}
       ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
  ]);

  return {
    rows: rowResult.rows,
    total: parseInt(countResult.rows[0]?.count ?? '0', 10),
  };
}

export async function getErrorQueueEntry(
  id: string,
): Promise<ErrorQueueEntry | null> {
  return queryOne<ErrorQueueEntry>(
    `SELECT * FROM error_queue WHERE id = $1`,
    [id],
  );
}
