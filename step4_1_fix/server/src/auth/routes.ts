import type { Router } from 'express'
import express from 'express'
import bcrypt from 'bcryptjs'

import { createUser, getUserByEmail, getUserByUsername, type SessionUser } from './db'
import { createResetToken, consumeResetTokenAndSetPassword } from './reset'

function normalizeUsername(raw: string): string {
  return (raw || '').trim()
}

function validateUsername(username: string): string | null {
  if (username.length < 3 || username.length > 18) return 'Username must be 3 to 18 characters.'
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return 'Username can only use letters, numbers, and underscore.'
  return null
}

function validatePassword(password: string): string | null {
  if (password.length < 8 || password.length > 72) return 'Password must be 8 to 72 characters.'
  return null
}

function normalizeEmail(raw: string): string {
  return (raw || '').trim().toLowerCase()
}

function validateEmail(email: string): string | null {
  if (!email) return 'Email is required.'
  if (email.length > 254) return 'Email is too long.'
  // Basic sanity check. We do not attempt strict RFC parsing.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Email is not valid.'
  return null
}

export function buildAuthRouter(): Router {
  const r = express.Router()

  r.get('/me', (req, res) => {
    const u = (req.session as any)?.user as SessionUser | undefined
    if (!u) return res.json({ ok: true, user: null })
    return res.json({ ok: true, user: { id: u.id, username: u.username } })
  })

  r.post('/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ ok: false, error: 'Logout failed' })
      res.clearCookie('cuse_pitch_sid')
      return res.json({ ok: true })
    })
  })

  r.post('/signup', async (req, res) => {
    const username = normalizeUsername(req.body?.username)
    const email = normalizeEmail(req.body?.email)
    const password = String(req.body?.password ?? '')

    const uErr = validateUsername(username)
    if (uErr) return res.status(400).json({ ok: false, error: uErr })
    const pErr = validatePassword(password)
    if (pErr) return res.status(400).json({ ok: false, error: pErr })

    const eErr = validateEmail(email)
    if (eErr) return res.status(400).json({ ok: false, error: eErr })

    const existing = await getUserByUsername(username)
    if (existing) return res.status(409).json({ ok: false, error: 'Username already taken.' })

    const existingEmail = await getUserByEmail(email)
    if (existingEmail) return res.status(409).json({ ok: false, error: 'Email is already in use.' })

    const passwordHash = bcrypt.hashSync(password, 12)
    const user = await createUser(username, email, passwordHash)

    ;(req.session as any).user = { id: user.id, username: user.username } satisfies SessionUser
    return res.json({ ok: true, user: { id: user.id, username: user.username } })
  })

  r.post('/login', async (req, res) => {
    const body = req.body ?? {}
    const identifierRaw = String(body.username ?? '').trim()
    const password = String(body.password ?? '')

    const identifier = identifierRaw.toLowerCase()
    const isEmail = identifier.includes('@')

    if (!identifier) return res.status(400).json({ ok: false, error: 'Invalid username or password.' })
    const pErr = validatePassword(password)
    if (pErr) return res.status(400).json({ ok: false, error: 'Invalid username or password.' })

    let user: Awaited<ReturnType<typeof getUserByUsername>> = null
    if (isEmail) {
      user = await getUserByEmail(identifier)
    } else {
      const uErr = validateUsername(identifierRaw)
      if (uErr) return res.status(400).json({ ok: false, error: 'Invalid username or password.' })
      user = await getUserByUsername(identifier)
    }

    if (!user) return res.status(401).json({ ok: false, error: 'Invalid username or password.' })

    const ok = bcrypt.compareSync(password, user.passwordHash)
    if (!ok) return res.status(401).json({ ok: false, error: 'Invalid username or password.' })

    ;(req.session as any).user = { id: user.id, username: user.username } satisfies SessionUser
    return res.json({ ok: true, user: { id: user.id, username: user.username } })
  })

  // Request a password reset email. Always returns ok to avoid account enumeration.
  r.post('/password-reset/request', async (req, res) => {
    const email = normalizeEmail(req.body?.email)
    const eErr = validateEmail(email)
    if (eErr) return res.status(400).json({ ok: false, error: eErr })

    // eslint-disable-next-line no-console
    console.log('[Cuse Pitch] Password reset requested for', email ? `${email.replace(/^(.{2})[\s\S]*@/, '$1***@')}` : '(empty)')

    const user = await getUserByEmail(email)
    if (!user) return res.json({ ok: true })

    try {
      const { token, resetUrl } = await createResetToken({ userId: user.id, email: user.email })
      // In development, help you test without SMTP by returning the token.
      if (process.env.NODE_ENV !== 'production' && process.env.RETURN_RESET_TOKEN === '1') {
        return res.json({ ok: true, dev: { token, resetUrl } })
      }
      return res.json({ ok: true })
    } catch {
      // Still return ok so we don't leak details.
      return res.json({ ok: true })
    }
  })

  // Exchange a valid reset token for a new password.
  r.post('/password-reset/confirm', async (req, res) => {
    const token = String(req.body?.token ?? '').trim()
    const newPassword = String(req.body?.password ?? '')
    const pErr = validatePassword(newPassword)
    if (pErr) return res.status(400).json({ ok: false, error: pErr })
    if (!token) return res.status(400).json({ ok: false, error: 'Reset token is required.' })

    const passwordHash = bcrypt.hashSync(newPassword, 12)
    const ok = await consumeResetTokenAndSetPassword(token, passwordHash)
    if (!ok) return res.status(400).json({ ok: false, error: 'Reset link is invalid or expired.' })

    return res.json({ ok: true })
  })

  return r
}
