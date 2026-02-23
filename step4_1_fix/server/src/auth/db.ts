import { getPool } from '../db/pool'

export type DbUser = {
  id: number
  username: string
  email: string
  passwordHash: string
  createdAt: string
}

export type SessionUser = {
  id: number
  username: string
}

export async function getUserByUsername(username: string): Promise<DbUser | null> {
  const u = (username || '').trim()
  if (!u) return null
  const pool = getPool()
  const res = await pool.query(
    'SELECT id, username, email, password_hash AS "passwordHash", created_at AS "createdAt" FROM users WHERE username = $1',
    [u]
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    id: Number(row.id),
    username: row.username,
    email: row.email ?? '',
    passwordHash: row.passwordHash,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  }
}

export async function getUserByEmail(email: string): Promise<DbUser | null> {
  const e = (email || '').trim().toLowerCase()
  if (!e) return null
  const pool = getPool()
  const res = await pool.query(
    'SELECT id, username, email, password_hash AS "passwordHash", created_at AS "createdAt" FROM users WHERE LOWER(email) = $1',
    [e]
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    id: Number(row.id),
    username: row.username,
    email: row.email ?? '',
    passwordHash: row.passwordHash,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  }
}

export async function getUserById(id: number): Promise<DbUser | null> {
  const pool = getPool()
  const res = await pool.query(
    'SELECT id, username, email, password_hash AS "passwordHash", created_at AS "createdAt" FROM users WHERE id = $1',
    [id]
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    id: Number(row.id),
    username: row.username,
    email: row.email ?? '',
    passwordHash: row.passwordHash,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  }
}

export async function createUser(username: string, email: string, passwordHash: string): Promise<DbUser> {
  const u = (username || '').trim()
  const e = (email || '').trim().toLowerCase()
  const pool = getPool()
  const res = await pool.query(
    `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)
     RETURNING id, username, email, password_hash AS "passwordHash", created_at AS "createdAt"`,
    [u, e || null, passwordHash]
  )
  const row = res.rows[0]
  return {
    id: Number(row.id),
    username: row.username,
    email: row.email ?? '',
    passwordHash: row.passwordHash,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  }
}

export async function updateUserPassword(userId: number, passwordHash: string): Promise<void> {
  const pool = getPool()
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId])
}

/** Returns only usernames from users table (no PII). For admin use. */
export async function getAllUsernames(): Promise<string[]> {
  const pool = getPool()
  const res = await pool.query<{ username: string }>('SELECT username FROM users ORDER BY username')
  return res.rows.map((r) => r.username)
}
