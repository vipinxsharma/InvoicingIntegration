import { Pool, PoolClient, QueryResult } from 'pg';
import { config } from '../config';

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error', err);
});

/**
 * Execute a single parameterised query and return the row array.
 * Using an explicit cast via Record<string,unknown> to satisfy pg's
 * QueryResultRow constraint while keeping the generic return type flexible.
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query<Record<string, unknown>>(sql, params);
  return result.rows as T[];
}

/**
 * Execute a single parameterised query and return the first row or null.
 */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return (rows[0] as T | undefined) ?? null;
}

/**
 * Wrap a callback in a serialisable transaction.
 * Automatically COMMIT on success or ROLLBACK on error.
 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Verify the connection is live (use at startup).
 */
export async function testConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
