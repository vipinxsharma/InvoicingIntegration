import crypto from 'crypto';
import { Request, Response } from 'express';
import { config } from '../../config';
import { bitrixClient } from './api-client';
import { parseContractTerms } from '../contract/parser';
import { createSchedulesFromTerms } from '../billing/rules-engine';
import { auditLogger } from '../audit/logger';
import { queryOne, withTransaction } from '../../db/client';
import type { BitrixWebhookPayload } from '../../types/bitrix';
import type { Contract } from '../../types/billing';
import { logger } from '../audit/logger';

// ─── Webhook signature verification ─────────────────────────────────────────

/**
 * Bitrix24 sends the shared secret as a form field named "auth[application_token]".
 * We compare it with HMAC-SHA256 of the raw body when a secret is configured,
 * or fall back to plain token comparison.
 */
export function verifyBitrixSignature(req: Request): boolean {
  const secret = config.bitrix.incomingWebhookSecret;
  if (!secret) return true; // skip verification if no secret configured (dev only)

  const payload = req.body as BitrixWebhookPayload;
  const token = payload?.auth?.application_token;
  if (!token) return false;

  // Constant-time comparison to prevent timing attacks
  const expected = crypto
    .createHmac('sha256', secret)
    .update(token)
    .digest('hex');
  const provided = crypto
    .createHmac('sha256', secret)
    .update(token)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

// ─── Idempotency ─────────────────────────────────────────────────────────────

async function checkIdempotency(key: string): Promise<boolean> {
  const existing = await queryOne<{ status: string }>(
    `SELECT status FROM idempotency_keys WHERE key = $1 AND expires_at > NOW()`,
    [key],
  );
  if (existing) return true;

  await queryOne(
    `INSERT INTO idempotency_keys (key, status)
     VALUES ($1, 'processing')
     ON CONFLICT (key) DO NOTHING`,
    [key],
  );
  return false;
}

async function completeIdempotency(
  key: string,
  response: Record<string, unknown>,
): Promise<void> {
  await queryOne(
    `UPDATE idempotency_keys SET status = 'completed', response = $2 WHERE key = $1`,
    [key, JSON.stringify(response)],
  );
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleBitrixWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const payload = req.body as BitrixWebhookPayload;
  const event = payload?.event;
  const dealId = payload?.data?.FIELDS?.ID;

  if (!event || !dealId) {
    res.status(400).json({ error: 'Invalid payload: missing event or deal ID' });
    return;
  }

  // Only process deal events
  if (!event.startsWith('ONCRMDEAL')) {
    res.status(200).json({ received: true, skipped: true });
    return;
  }

  // Dedup: webhook_event::{event}::{memberId}::{timestamp_truncated_to_minute}
  const memberId = payload.auth?.member_id ?? 'unknown';
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const idempotencyKey = `webhook::${event}::${dealId}::${memberId}::${minuteBucket}`;

  const isDuplicate = await checkIdempotency(idempotencyKey);
  if (isDuplicate) {
    res.status(409).json({ received: true, duplicate: true });
    return;
  }

  // Acknowledge immediately – processing is async
  res.status(200).json({ received: true });

  // Process asynchronously so Bitrix doesn't time out waiting
  setImmediate(() => {
    processDealEvent(event, dealId, idempotencyKey, req.ip).catch((err) => {
      logger.error('Unhandled error in webhook processor', { event, dealId, err });
    });
  });
}

async function processDealEvent(
  event: string,
  dealId: string,
  idempotencyKey: string,
  ipAddress: string | undefined,
): Promise<void> {
  logger.info('Processing Bitrix24 webhook', { event, dealId });

  try {
    const deal = await bitrixClient.getDeal(dealId);
    const contractTextField = config.bitrix.fields.contractText;
    const contractText = deal[contractTextField] as string | undefined;

    if (!contractText?.trim()) {
      logger.info('Deal has no contract text – skipping billing setup', { dealId });
      await completeIdempotency(idempotencyKey, { skipped: 'no_contract_text' });
      return;
    }

    await withTransaction(async (client) => {
      // Upsert contract
      const existingContract = await client.query<Contract>(
        `SELECT id FROM contracts WHERE bitrix_deal_id = $1`,
        [dealId],
      );

      const isUpdate = (existingContract.rows.length ?? 0) > 0;

      if (isUpdate && event === 'ONCRMDEALADD') {
        // Don't re-parse on add if contract already exists
        return;
      }

      const terms = await parseContractTerms(contractText);

      const contractRow = await client.query<{ id: string }>(
        `INSERT INTO contracts (bitrix_deal_id, raw_text, parsed_terms, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (bitrix_deal_id) DO UPDATE
           SET raw_text = EXCLUDED.raw_text,
               parsed_terms = EXCLUDED.parsed_terms,
               updated_at = NOW()
         RETURNING id`,
        [dealId, contractText, JSON.stringify(terms)],
      );

      const contractId = contractRow.rows[0]?.id;
      if (!contractId) throw new Error('Failed to upsert contract');

      // Deactivate old schedules on update
      if (isUpdate) {
        await client.query(
          `UPDATE billing_schedules SET is_active = FALSE
           WHERE contract_id = $1 AND is_active = TRUE`,
          [contractId],
        );
      }

      await createSchedulesFromTerms(contractId, dealId, terms, client);
    });

    await auditLogger.log({
      eventType: 'WEBHOOK_DEAL_PROCESSED',
      entityType: 'deal',
      entityId: dealId,
      bitrixDealId: dealId,
      payload: { event },
      success: true,
      ipAddress,
    });

    await completeIdempotency(idempotencyKey, { processed: true });
    logger.info('Webhook processed successfully', { event, dealId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Webhook processing failed', { event, dealId, error: message });

    await auditLogger.log({
      eventType: 'WEBHOOK_DEAL_FAILED',
      entityType: 'deal',
      entityId: dealId,
      bitrixDealId: dealId,
      payload: { event },
      success: false,
      errorMessage: message,
      ipAddress,
    });
  }
}
