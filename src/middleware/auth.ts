import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';

/**
 * API-key guard for admin routes.
 * Expects the key in the `X-Admin-Api-Key` header.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function requireAdminApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const provided = req.headers['x-admin-api-key'];

  if (!provided || typeof provided !== 'string') {
    res.status(401).json({ error: 'Missing X-Admin-Api-Key header' });
    return;
  }

  if (!config.adminApiKey) {
    res.status(500).json({ error: 'Admin API key not configured' });
    return;
  }

  const expected = crypto
    .createHmac('sha256', 'billing-service')
    .update(config.adminApiKey)
    .digest();
  const given = crypto
    .createHmac('sha256', 'billing-service')
    .update(provided)
    .digest();

  if (!crypto.timingSafeEqual(expected, given)) {
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }

  next();
}
