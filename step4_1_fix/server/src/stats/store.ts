import fs from 'fs'
import path from 'path'

const MAX_PROCESSED_HAND_KEYS = 200

/** Compute bid success rate (bidsMade / bidsAttempted) clamped to [0, 1]. Never exceeds 100%. */
export function computeBidRate(bidsAttempted: number, bidsMade: number): number {
  if (bidsAttempted <= 0) return 0
  const rate = bidsMade / bidsAttempted
  return Math.min(1, Math.max(0, Number.isNaN(rate) ? 0 : rate))
}

export type PersistedStats = {
  userId: number
  username: string
  gamesPlayed: number
  wins: number
  losses: number
  /** Hands where this user was the bidder (attempted a bid). */
  bidsAttempted: number
  /** Hands where this user made their bid. */
  bidsMade: number
  stmSuccess: number
  updatedAt: string
  /** Keys of completed hands/games already applied; keep last 200 for de-dup. */
  processedHandKeys?: string[]
  /** Last handId for which we counted a bid attempt (idempotency). */
  lastBidAttemptHandId?: string
  /** Last handId for which we counted a bid made (idempotency). */
  lastBidMadeHandId?: string
  /** @deprecated Use bidsAttempted for rate denominator. */
  bidsWon?: number
}

type StoreShape = {
  statsByUserId: Record<string, PersistedStats>
}

/** Single function to compute stats file path. Called once at module load. */
function computeStatsPath(): string {
  if (process.env.CUSE_PITCH_STATS_PATH) return path.resolve(process.env.CUSE_PITCH_STATS_PATH)
  if (process.env.NODE_ENV === 'production') return '/data/stats.json'
  return path.resolve('./stats.json')
}

const storePath = computeStatsPath()
console.log('[STATS] using path=%s', storePath)

/** Last successfully read store; used on transient parse errors to avoid resetting to empty. */
let lastGoodStore: StoreShape | null = null

function resolveStorePath(): string {
  return storePath
}

function readStore(): StoreShape {
  const p = resolveStorePath()
  if (!fs.existsSync(p)) {
    const empty: StoreShape = { statsByUserId: {} }
    writeStore(empty)
    lastGoodStore = empty
    console.log('[STATS] load path=%s players=0 (created empty store)', p)
    return empty
  }
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoreShape>
    const statsByUserId = (parsed.statsByUserId && typeof parsed.statsByUserId === 'object')
      ? (parsed.statsByUserId as Record<string, PersistedStats>)
      : {}
    const store: StoreShape = { statsByUserId }
    lastGoodStore = store
    const count = Object.keys(store.statsByUserId).length
    console.log('[STATS] load path=%s players=%s', p, count)
    return store
  } catch (err) {
    console.warn('[STATS] load failed path=%s error=%s', p, (err as Error)?.message ?? err)
    if (lastGoodStore) {
      const count = Object.keys(lastGoodStore.statsByUserId).length
      console.log('[STATS] using last known good store path=%s players=%s', p, count)
      return lastGoodStore
    }
    return { statsByUserId: {} }
  }
}

function writeStore(store: StoreShape): void {
  const p = resolveStorePath()
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    console.log('[STATS] created directory path=%s', dir)
  }
  const tmp = `${p}.tmp`
  const data = JSON.stringify(store, null, 2)
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, p)
  const count = Object.keys(store.statsByUserId).length
  const sizeBytes = Buffer.byteLength(data, 'utf8')
  console.log('[STATS] write complete path=%s players=%s sizeBytes=%s', p, count, sizeBytes)
}

export function getStats(userId: number): PersistedStats | null {
  const store = readStore()
  const key = String(userId)
  const found = store.statsByUserId[key] ?? null
  const p = resolveStorePath()
  console.log('[STATS] profile read userId=%s found=%s path=%s', key, !!found, p)
  return found
}

export function upsertAddGame(params: {
  userId: number
  username: string
  didWin: boolean
  /** Stable key for this completed hand; if already in processedHandKeys, skip apply. */
  handKey: string
  /** Hand id for idempotency (same as handKey or stable handId). */
  handId: string
  /** This hand: did this user attempt a bid (were they the bidder)? */
  didAttempt: boolean
  /** This hand: did this user make their bid? */
  didMake: boolean
  stmSuccess: number
}): PersistedStats {
  const store = readStore()
  const key = String(params.userId)
  const now = new Date().toISOString()

  const existing = store.statsByUserId[key]
  const processedKeys = existing?.processedHandKeys && Array.isArray(existing.processedHandKeys) ? existing.processedHandKeys : []

  if (processedKeys.includes(params.handKey)) {
    console.log('[STATS] apply hand userId=%s handKey=%s skipped (already processed)', key, params.handKey)
    return existing!
  }

  const base: PersistedStats = existing ?? (() => {
    console.log('[STATS] init userId=%s (new user)', key)
    return {
      userId: params.userId,
      username: params.username,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      bidsAttempted: 0,
      bidsMade: 0,
      stmSuccess: 0,
      updatedAt: now,
      processedHandKeys: [],
    }
  })()

  const lastAttemptHandId = base.lastBidAttemptHandId
  const lastMadeHandId = base.lastBidMadeHandId
  const countAttempt = params.didAttempt && lastAttemptHandId !== params.handId ? 1 : 0
  const countMade = params.didMake && lastMadeHandId !== params.handId ? 1 : 0

  let bidsAttempted = (base.bidsAttempted ?? Math.max(base.bidsMade ?? 0, base.bidsWon ?? 0)) + countAttempt
  let bidsMade = (base.bidsMade ?? 0) + countMade
  bidsAttempted = Math.max(0, bidsAttempted)
  bidsMade = Math.max(0, bidsMade)
  if (bidsMade > bidsAttempted) bidsMade = bidsAttempted

  const nextProcessed = [...(base.processedHandKeys ?? []), params.handKey].slice(-MAX_PROCESSED_HAND_KEYS)

  const next: PersistedStats = {
    ...base,
    username: params.username || base.username,
    gamesPlayed: base.gamesPlayed + 1,
    wins: base.wins + (params.didWin ? 1 : 0),
    losses: base.losses + (params.didWin ? 0 : 1),
    bidsAttempted,
    bidsMade,
    stmSuccess: base.stmSuccess + Math.max(0, params.stmSuccess ?? 0),
    updatedAt: now,
    processedHandKeys: nextProcessed,
    lastBidAttemptHandId: countAttempt ? params.handId : lastAttemptHandId,
    lastBidMadeHandId: countMade ? params.handId : lastMadeHandId,
  }

  const deltas = {
    gamesPlayed: 1,
    wins: params.didWin ? 1 : 0,
    losses: params.didWin ? 0 : 1,
    bidsAttempted: countAttempt,
    bidsMade: countMade,
    stmSuccess: Math.max(0, params.stmSuccess ?? 0),
  }
  const p = resolveStorePath()
  console.log('[STATS] update userId=%s deltas=%s path=%s', key, JSON.stringify(deltas), p)

  store.statsByUserId[key] = next
  writeStore(store)
  console.log('[STATS] apply hand userId=%s handId=%s didAttempt=%s didMake=%s -> bidsAttempted=%s bidsMade=%s', key, params.handId, params.didAttempt, params.didMake, next.bidsAttempted, next.bidsMade)
  return next
}
