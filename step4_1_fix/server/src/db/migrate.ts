import { getPool } from './pool'

const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: 'users',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id bigserial PRIMARY KEY,
        username text UNIQUE NOT NULL,
        email text UNIQUE,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
    `.trim(),
  },
  {
    name: 'session',
    sql: `
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        PRIMARY KEY ("sid")
      );
      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
    `.trim(),
  },
  {
    name: 'player_stats',
    sql: `
      CREATE TABLE IF NOT EXISTS player_stats (
        user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        games_played int NOT NULL DEFAULT 0,
        games_won int NOT NULL DEFAULT 0,
        hands_played int NOT NULL DEFAULT 0,
        hands_won int NOT NULL DEFAULT 0,
        bids_made int NOT NULL DEFAULT 0,
        bids_won int NOT NULL DEFAULT 0,
        trump_calls int NOT NULL DEFAULT 0,
        points_for int NOT NULL DEFAULT 0,
        points_against int NOT NULL DEFAULT 0,
        last_played_at timestamptz,
        bids_attempted int NOT NULL DEFAULT 0,
        stm_success int NOT NULL DEFAULT 0,
        processed_hand_keys jsonb NOT NULL DEFAULT '[]',
        last_bid_attempt_hand_id text,
        last_bid_made_hand_id text
      );
    `.trim(),
  },
  {
    name: 'password_resets',
    sql: `
      CREATE TABLE IF NOT EXISTS password_resets (
        id bigserial PRIMARY KEY,
        token_hash text NOT NULL,
        user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets (token_hash);
      CREATE INDEX IF NOT EXISTS idx_password_resets_expires_at ON password_resets (expires_at);
    `.trim(),
  },
]

/** Run all migrations. Idempotent. Throws on any SQL error so process can crash and Fly restarts. */
export async function runMigrations(): Promise<void> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    for (const m of MIGRATIONS) {
      try {
        await client.query(m.sql)
        console.log('[DB] migration ran: %s', m.name)
      } catch (err: any) {
        const msg = err?.message ?? String(err)
        console.error('[DB] migration failed: %s – %s', m.name, msg)
        throw new Error(`Migration "${m.name}" failed: ${msg}`)
      }
    }
  } finally {
    client.release()
  }
}
