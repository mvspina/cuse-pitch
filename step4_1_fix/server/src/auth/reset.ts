import crypto from 'crypto'

import nodemailer from 'nodemailer'

import { getPool } from '../db/pool'
import { getUserById, updateUserPassword } from './db'

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

async function sendResetEmail(opts: { to: string; resetUrl: string }): Promise<void> {
  const host = process.env.SMTP_HOST
  const port = Number(process.env.SMTP_PORT || '587')
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  const from = process.env.SMTP_FROM || 'no-reply@cusepitch.local'

  if (!host || !user || !pass) {
    console.log('[Cuse Pitch] Password reset requested; SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS). Link not sent.')
    return
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })

  try {
    await transporter.sendMail({
      from,
      to: opts.to,
      subject: 'Cuse Pitch password reset',
      text: `Reset your password using this link: ${opts.resetUrl}`,
    })
    console.log('[Cuse Pitch] Password reset email sent successfully to', opts.to.replace(/^(.{2})[\s\S]*@/, '$1***@'))
  } catch (err: any) {
    console.warn('[Cuse Pitch] Password reset email send failed:', err?.message ?? err)
    throw err
  }
}

function getBaseUrl(): string {
  const env = (process.env.APP_BASE_URL || '').trim()
  if (env) return env
  if (process.env.NODE_ENV === 'production') return 'https://syracuse-pitch.fly.dev'
  return 'http://localhost:5173'
}

export async function createResetToken(opts: { userId: number; email: string }): Promise<{ token: string; resetUrl: string }> {
  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = sha256Hex(rawToken)
  const ttlMs = 1000 * 60 * 30
  const expiresAt = new Date(Date.now() + ttlMs)

  const pool = getPool()
  await pool.query(
    'INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [tokenHash, opts.userId, expiresAt]
  )

  const resetUrl = `${getBaseUrl()}/?reset=${encodeURIComponent(rawToken)}`
  await sendResetEmail({ to: opts.email, resetUrl })

  return { token: rawToken, resetUrl }
}

export async function consumeResetTokenAndSetPassword(rawToken: string, newPasswordHash: string): Promise<boolean> {
  const tokenHash = sha256Hex(rawToken)
  const pool = getPool()

  const res = await pool.query(
    `SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND expires_at > now()`,
    [tokenHash]
  )
  const row = res.rows[0]
  if (!row) return false

  const user = await getUserById(Number(row.user_id))
  if (!user) {
    await pool.query('DELETE FROM password_resets WHERE id = $1', [row.id])
    return false
  }

  await updateUserPassword(user.id, newPasswordHash)
  await pool.query('DELETE FROM password_resets WHERE id = $1', [row.id])
  return true
}
