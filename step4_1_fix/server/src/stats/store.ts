import fs from 'fs'
import path from 'path'

const MAX_PROCESSED_HAND_KEYS = 200

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
  /** Keys of completed hands/games already applied; keep last 200 for de-dup. */
  processedHandKeys?: string[]
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
  } catch (err) {
    // Do NOT overwrite the file with empty - that would wipe all stats. Return empty in-memory only.
    console.warn('[STATS] readStore failed (file corrupt or unreadable), returning empty in-memory only:', (err as Error)?.message ?? err)
    return { statsByUserId: {} }
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
  const key = String(userId)
  const found = store.statsByUserId[key] ?? null
  const values = found
    ? { gamesPlayed: found.gamesPlayed, wins: found.wins, losses: found.losses, bidsWon: found.bidsWon, bidsMade: found.bidsMade, stmSuccess: found.stmSuccess }
    : null
  console.log('[STATS LOAD] userId=%s found=%s values=%s', key, !!found, values != null ? JSON.stringify(values) : 'null')
  return found
}

export function upsertAddGame(params: {
  userId: number
  username: string
  didWin: boolean
  bidsWon: number
  bidsMade: number
  stmSuccess: number
  /** Stable key for this completed hand/game; if already in processedHandKeys, skip apply. */
  handKey: string
}): PersistedStats {
  const store = readStore()
  const key = String(params.userId)
  const now = new Date().toISOString()

  const existing = store.statsByUserId[key]
  const processedKeys = existing?.processedHandKeys && Array.isArray(existing.processedHandKeys) ? existing.processedHandKeys : []

  if (processedKeys.includes(params.handKey)) {
    console.log('[STATS APPLY HAND] userId=%s handKey=%s skipped (already processed)', key, params.handKey)
    return existing!
  }

  const base: PersistedStats = existing ?? (() => {
    console.log('[STATS INIT] userId=%s (new user, no existing record)', key)
    return {
      userId: params.userId,
      username: params.username,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      bidsWon: 0,
      bidsMade: 0,
      stmSuccess: 0,
      updatedAt: now,
      processedHandKeys: [],
    }
  })()

  const inc = {
    bidsMade: Math.max(0, params.bidsMade ?? 0),
    bidsWon: Math.max(0, params.bidsWon ?? 0),
    didWin: params.didWin,
    stmSuccess: Math.max(0, params.stmSuccess ?? 0),
  }
  console.log('[STATS APPLY HAND]', { userId: params.userId, handKey: params.handKey, inc })

  let bidsMade = base.bidsMade + inc.bidsMade
  let bidsWon = base.bidsWon + inc.bidsWon
  if (bidsMade < 0) bidsMade = 0
  if (bidsWon < 0) bidsWon = 0
  if (bidsWon > bidsMade) bidsWon = bidsMade

  const nextProcessed = [...(base.processedHandKeys ?? []), params.handKey].slice(-MAX_PROCESSED_HAND_KEYS)

  const next: PersistedStats = {
    ...base,
    username: params.username || base.username,
    gamesPlayed: base.gamesPlayed + 1,
    wins: base.wins + (params.didWin ? 1 : 0),
    losses: base.losses + (params.didWin ? 0 : 1),
    bidsWon,
    bidsMade,
    stmSuccess: base.stmSuccess + inc.stmSuccess,
    updatedAt: now,
    processedHandKeys: nextProcessed,
  }

  store.statsByUserId[key] = next
  writeStore(store)
  const values = { gamesPlayed: next.gamesPlayed, wins: next.wins, losses: next.losses, bidsWon: next.bidsWon, bidsMade: next.bidsMade, stmSuccess: next.stmSuccess }
  console.log('[STATS SAVE] userId=%s values=%s', key, JSON.stringify(values))
  return next
}
