import { config, requireProductionConfig } from './config';
import { testConnection, closePool } from './db/client';
import { startScheduler } from './modules/billing/scheduler';
import { logger } from './modules/audit/logger';
import app from './app';
import http from 'http';

async function bootstrap(): Promise<void> {
  if (config.env === 'production') {
    requireProductionConfig();
  }

  logger.info('Billing Service starting', {
    env: config.env,
    port: config.port,
    bitrixEnv: config.bitrix.environment,
    ledgersEnv: config.ledgers.environment,
  });

  // Verify database connection before accepting traffic
  await testConnection();
  logger.info('Database connection verified');

  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, () => resolve());
    server.on('error', reject);
  });

  logger.info(`HTTP server listening on port ${config.port}`);

  // Start scheduled jobs only in non-test environments
  if (config.env !== 'test') {
    startScheduler();
  }

  // ─── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal} – shutting down gracefully`);

    server.close(async () => {
      logger.info('HTTP server closed');
      await closePool();
      logger.info('Database pool closed');
      process.exit(0);
    });

    // Force exit after 15 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 15_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
