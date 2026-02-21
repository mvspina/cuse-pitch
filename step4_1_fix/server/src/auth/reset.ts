import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import nodemailer from 'nodemailer'

import { getUserById, type DbUser } from './db'

type ResetRecord = {
  tokenHash: string
  userId: number
  expiresAt: number
  createdAt: number
}

type ResetStore = {
  resets: ResetRecord[]
}

let storePath: string | null = null

function resolveStorePath(): string {
  if (storePath) return storePath
  const serverRoot = path.resolve(__dirname, '..', '..', '..')
  const p = process.env.CUSE_PITCH_RESETS_PATH
    ? path.resolve(process.env.CUSE_PITCH_RESETS_PATH)
    : path.join(serverRoot, 'password_resets.json')
  storePath = p
  return p
}

function readStore(): ResetStore {
  const p = resolveStorePath()
  if (!fs.existsSync(p)) {
    const empty: ResetStore = { resets: [] }
    writeStore(empty)
    return empty
  }
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ResetStore>
    const resets = Array.isArray(parsed.resets) ? (parsed.resets as ResetRecord[]) : []
    return { resets }
  } catch {
    const empty: ResetStore = { resets: [] }
    writeStore(empty)
    return empty
  }
}

function writeStore(store: ResetStore): void {
  const p = resolveStorePath()
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function purgeExpired(store: ResetStore): ResetStore {
  const now = Date.now()
  const resets = store.resets.filter((r) => r.expiresAt > now)
  if (resets.length !== store.resets.length) return { resets }
  return store
}

async function sendResetEmail(opts: { to: string; resetUrl: string }): Promise<void> {
  const host = process.env.SMTP_HOST
  const port = Number(process.env.SMTP_PORT || '587')
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  const from = process.env.SMTP_FROM || 'no-reply@cusepitch.local'

  if (!host || !user || !pass) {
    // eslint-disable-next-line no-console
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
    // eslint-disable-next-line no-console
    console.log('[Cuse Pitch] Password reset email sent successfully to', opts.to.replace(/^(.{2})[\s\S]*@/, '$1***@'))
  } catch (err: any) {
    // eslint-disable-next-line no-console
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
  const now = Date.now()
  const rec: ResetRecord = { tokenHash, userId: opts.userId, expiresAt: now + ttlMs, createdAt: now }

  let store = readStore()
  store = purgeExpired(store)
  store.resets.push(rec)
  writeStore(store)

  const resetUrl = `${getBaseUrl()}/?reset=${encodeURIComponent(rawToken)}`
  await sendResetEmail({ to: opts.email, resetUrl })

  return { token: rawToken, resetUrl }
}

export function consumeResetTokenAndSetPassword(rawToken: string, newPasswordHash: string): boolean {
  const tokenHash = sha256Hex(rawToken)
  let store = readStore()
  store = purgeExpired(store)

  const idx = store.resets.findIndex((r) => r.tokenHash === tokenHash)
  if (idx < 0) {
    writeStore(store)
    return false
  }
  const rec = store.resets[idx]
  const user = getUserById(rec.userId)
  if (!user) {
    store.resets.splice(idx, 1)
    writeStore(store)
    return false
  }

  // Update password.
  updateUserPassword(user, newPasswordHash)

  // One time token.
  store.resets.splice(idx, 1)
  writeStore(store)
  return true
}

function updateUserPassword(user: DbUser, passwordHash: string): void {
  // Minimal in place update: read users store, replace passwordHash, write back.
  const serverRoot = path.resolve(__dirname, '..', '..', '..')
  const usersPath = process.env.CUSE_PITCH_USERS_PATH
    ? path.resolve(process.env.CUSE_PITCH_USERS_PATH)
    : path.join(serverRoot, 'users.json')

  if (!fs.existsSync(usersPath)) return
  try {
    const raw = fs.readFileSync(usersPath, 'utf8')
    const parsed = JSON.parse(raw) as any
    const users = Array.isArray(parsed?.users) ? parsed.users : []
    const idx = users.findIndex((u: any) => u?.id === user.id)
    if (idx >= 0) {
      users[idx] = { ...users[idx], passwordHash }
      const next = { ...parsed, users }
      const tmp = `${usersPath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
      fs.renameSync(tmp, usersPath)
    }
  } catch {
    // ignore
  }
}
