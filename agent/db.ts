import { Pool } from 'pg';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;
  _pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT ? Number(process.env.POSTGRES_PORT) : 5432,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
    connectionTimeoutMillis: 3000,
  });
  // An idle client emitting 'error' (managed DB restart) must not crash the process.
  _pool.on('error', (err) => console.error('[slack-radar] idle pg client error:', err.message));
  return _pool;
}

const TRANSIENT_PG = new Set(['57P03', '57P01', '57P02', '53300', '08000', '08001', '08003', '08004', '08006']);
const TRANSIENT_NET = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE']);

export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (!code) return true; // connection-terminated errors carry no code; treat as transient
  return TRANSIENT_PG.has(code) || TRANSIENT_NET.has(code);
}

export async function withDbRetry<T>(fn: () => Promise<T>, label: string, attempts = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientDbError(err) || i >= attempts) throw err;
      const delay = Math.min(500 * 2 ** (i - 1), 8000);
      console.warn(
        `[slack-radar] ${label} failed (attempt ${i}/${attempts}), retry in ${delay}ms:`,
        (err as Error).message,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
