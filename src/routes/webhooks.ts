import { Router, Request, Response } from 'express';
import { handleBitrixWebhook, verifyBitrixSignature } from '../modules/bitrix/webhook-handler';

const router = Router();

/**
 * POST /webhooks/bitrix
 *
 * Receives Bitrix24 CRM events.
 * Bitrix24 sends a URL-encoded body by default; Express parses it as JSON
 * if the Content-Type header is application/json, or as urlencoded otherwise.
 * We handle both.
 */
router.post('/bitrix', (req: Request, res: Response) => {
  if (!verifyBitrixSignature(req)) {
    res.status(403).json({ error: 'Invalid webhook signature' });
    return;
  }

  handleBitrixWebhook(req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  });
});

export default router;
