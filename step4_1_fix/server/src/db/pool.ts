import { Pool } from 'pg'

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL
    if (!url || url.trim() === '') {
      const err = new Error('DATABASE_URL is not set')
      console.error('[DB]', err.message)
      throw err
    }
    pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
    pool.on('error', (err: unknown) => console.error('[DB] pool error:', err instanceof Error ? err.message : err))
  }
  return pool
}

/** Ping the database; rejects if unreachable or timeout. */
export async function pingDb(timeoutMs: number = 1000): Promise<void> {
  const p = getPool()
  const client = await p.connect()
  try {
    const t = setTimeout(() => {
      client.release(new Error('ping timeout'))
    }, timeoutMs)
    await client.query('SELECT 1')
    clearTimeout(t)
  } finally {
    client.release()
  }
}
