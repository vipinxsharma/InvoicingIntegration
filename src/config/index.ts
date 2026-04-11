import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Env var ${name} must be an integer, got: ${raw}`);
  return parsed;
}

export const config = {
  env: optionalEnv('NODE_ENV', 'development') as 'development' | 'production' | 'test',
  port: optionalInt('PORT', 3000),

  db: {
    host: optionalEnv('DB_HOST', 'localhost'),
    port: optionalInt('DB_PORT', 5432),
    database: optionalEnv('DB_NAME', 'billing_service'),
    user: optionalEnv('DB_USER', 'postgres'),
    password: optionalEnv('DB_PASSWORD', ''),
    ssl: optionalEnv('DB_SSL', 'false') === 'true',
    poolMax: optionalInt('DB_POOL_MAX', 20),
  },

  bitrix: {
    domain: optionalEnv('BITRIX_DOMAIN', ''),
    userId: optionalEnv('BITRIX_USER_ID', '1'),
    webhookToken: optionalEnv('BITRIX_WEBHOOK_TOKEN', ''),
    incomingWebhookSecret: optionalEnv('BITRIX_INCOMING_WEBHOOK_SECRET', ''),
    environment: optionalEnv('BITRIX_ENV', 'sandbox') as 'sandbox' | 'production',

    fields: {
      contractText: optionalEnv('BITRIX_FIELD_CONTRACT_TEXT', 'UF_CRM_CONTRACT_TEXT'),
      contractStart: optionalEnv('BITRIX_FIELD_CONTRACT_START', 'UF_CRM_CONTRACT_START'),
      contractEnd: optionalEnv('BITRIX_FIELD_CONTRACT_END', 'UF_CRM_CONTRACT_END'),
      ledgersContactId: optionalEnv('BITRIX_FIELD_LEDGERS_CONTACT_ID', 'UF_CRM_LEDGERS_CONTACT_ID'),
      ledgersInvoiceIds: optionalEnv('BITRIX_FIELD_LEDGERS_INVOICE_IDS', 'UF_CRM_LEDGERS_INVOICE_IDS'),
    },
  },

  ledgers: {
    apiKey: optionalEnv('LEDGERS_API_KEY', ''),
    baseUrl: optionalEnv('LEDGERS_BASE_URL', 'https://api.ledgers.io/v1'),
    environment: optionalEnv('LEDGERS_ENV', 'sandbox') as 'sandbox' | 'production',
  },

  claude: {
    apiKey: optionalEnv('ANTHROPIC_API_KEY', ''),
    model: optionalEnv('CLAUDE_MODEL', 'claude-opus-4-6'),
  },

  adminApiKey: optionalEnv('ADMIN_API_KEY', ''),

  scheduler: {
    billingCheckCron: optionalEnv('BILLING_CHECK_CRON', '0 0 * * *'),
    retryProcessorCron: optionalEnv('RETRY_PROCESSOR_CRON', '0 * * * *'),
  },

  retry: {
    maxAttempts: optionalInt('MAX_RETRY_ATTEMPTS', 5),
    baseDelayMs: optionalInt('RETRY_BASE_DELAY_MS', 60000),
  },
} as const;

export function requireProductionConfig(): void {
  requireEnv('BITRIX_DOMAIN');
  requireEnv('BITRIX_WEBHOOK_TOKEN');
  requireEnv('BITRIX_INCOMING_WEBHOOK_SECRET');
  requireEnv('LEDGERS_API_KEY');
  requireEnv('ANTHROPIC_API_KEY');
  requireEnv('ADMIN_API_KEY');
  requireEnv('DB_PASSWORD');
}
