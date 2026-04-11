import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import adminRouter from './routes/admin';
import webhooksRouter from './routes/webhooks';
import { requireAdminApiKey } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';

const app = express();

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ─── Request logging ──────────────────────────────────────────────────────────
app.use(
  morgan(process.env['NODE_ENV'] === 'production' ? 'combined' : 'dev'),
);

// ─── Body parsers ─────────────────────────────────────────────────────────────
// Bitrix24 can send application/x-www-form-urlencoded
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// ─── Health check (no auth) ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/webhooks', webhookLimiter, webhooksRouter);
app.use('/admin', adminLimiter, requireAdminApiKey, adminRouter);

// ─── Error handling ───────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
