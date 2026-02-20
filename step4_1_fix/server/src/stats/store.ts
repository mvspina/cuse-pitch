import fs from 'fs'
import path from 'path'

export type PersistedStats = {
  userId: number
  username: string
  gamesPlayed: number
  wins: number
  losses: number
  bidsWon: number
  bidsMade: number
  stmSuccess: number
  updatedAt: string
}

type StoreShape = {
  statsByUserId: Record<string, PersistedStats>
}

let storePath: string | null = null

function resolveStorePath(): string {
  if (storePath) return storePath
  // Persist relative to the server directory (not process.cwd), so running with
  // different working directories (root vs server) doesn't create a fresh store.
  const serverRoot = path.resolve(__dirname, '..', '..', '..')
  const p = process.env.CUSE_PITCH_STATS_PATH
    ? path.resolve(process.env.CUSE_PITCH_STATS_PATH)
    : path.join(serverRoot, 'stats.json')
  storePath = p
  return p
}

function readStore(): StoreShape {
  const p = resolveStorePath()
  if (!fs.existsSync(p)) {
    const empty: StoreShape = { statsByUserId: {} }
    writeStore(empty)
    return empty
  }
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoreShape>
    const statsByUserId = (parsed.statsByUserId && typeof parsed.statsByUserId === 'object')
      ? (parsed.statsByUserId as Record<string, PersistedStats>)
      : {}
    return { statsByUserId }
  } catch {
    const empty: StoreShape = { statsByUserId: {} }
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

export function getStats(userId: number): PersistedStats | null {
  const store = readStore()
  return store.statsByUserId[String(userId)] ?? null
}

export function upsertAddGame(params: {
  userId: number
  username: string
  didWin: boolean
  bidsWon: number
  bidsMade: number
  stmSuccess: number
}): PersistedStats {
  const store = readStore()
  const key = String(params.userId)
  const now = new Date().toISOString()

  const existing = store.statsByUserId[key]
  const base: PersistedStats = existing ?? {
    userId: params.userId,
    username: params.username,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    bidsWon: 0,
    bidsMade: 0,
    stmSuccess: 0,
    updatedAt: now,
  }

  const next: PersistedStats = {
    ...base,
    username: params.username || base.username,
    gamesPlayed: base.gamesPlayed + 1,
    wins: base.wins + (params.didWin ? 1 : 0),
    losses: base.losses + (params.didWin ? 0 : 1),
    bidsWon: base.bidsWon + Math.max(0, params.bidsWon || 0),
    bidsMade: base.bidsMade + Math.max(0, params.bidsMade || 0),
    stmSuccess: base.stmSuccess + Math.max(0, params.stmSuccess || 0),
    updatedAt: now,
  }

  store.statsByUserId[key] = next
  writeStore(store)
  return next
}
