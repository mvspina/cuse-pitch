import fs from 'fs'
import path from 'path'

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

type StoreShape = {
  nextId: number
  users: DbUser[]
}

let storePath: string | null = null

function resolveStorePath(): string {
  if (storePath) return storePath
  // Persist relative to the server directory (not process.cwd), so running with
  // different working directories (root vs server) doesn't create a fresh store.
  const serverRoot = path.resolve(__dirname, '..', '..', '..')
  const p = process.env.CUSE_PITCH_USERS_PATH
    ? path.resolve(process.env.CUSE_PITCH_USERS_PATH)
    : path.join(serverRoot, 'users.json')
  storePath = p
  return p
}

function readStore(): StoreShape {
  const p = resolveStorePath()
  if (!fs.existsSync(p)) {
    const empty: StoreShape = { nextId: 1, users: [] }
    writeStore(empty)
    return empty
  }
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoreShape>
    const nextId = typeof parsed.nextId === 'number' ? parsed.nextId : 1
    const users = Array.isArray(parsed.users) ? (parsed.users as DbUser[]) : []
    return { nextId, users }
  } catch {
    const empty: StoreShape = { nextId: 1, users: [] }
    writeStore(empty)
    return empty
  }
}

function writeStore(store: StoreShape): void {
  const p = resolveStorePath()
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

export function getUserByUsername(username: string): DbUser | null {
  const u = (username || '').trim()
  if (!u) return null
  const store = readStore()
  const found = store.users.find((x) => x.username === u)
  return found ?? null
}

export function getUserByEmail(email: string): DbUser | null {
  const e = (email || '').trim().toLowerCase()
  if (!e) return null
  const store = readStore()
  const found = store.users.find((x) => (x.email || '').toLowerCase() === e)
  return found ?? null
}

export function getUserById(id: number): DbUser | null {
  const store = readStore()
  const found = store.users.find((x) => x.id === id)
  return found ?? null
}

export function createUser(username: string, email: string, passwordHash: string): DbUser {
  const u = (username || '').trim()
  const e = (email || '').trim().toLowerCase()
  const store = readStore()
  const now = new Date().toISOString()
  const user: DbUser = {
    id: store.nextId,
    username: u,
    email: e,
    passwordHash,
    createdAt: now,
  }
  store.nextId += 1
  store.users.push(user)
  writeStore(store)
  return user
}
