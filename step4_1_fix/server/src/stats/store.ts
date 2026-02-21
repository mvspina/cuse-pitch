import type { QueryResult } from 'pg'

import { getPool } from '../db/pool'

const MAX_PROCESSED_HAND_KEYS = 200

interface PlayerStatsRow {
  user_id: number
  games_played: number
  games_won: number
  hands_played?: number
  hands_won?: number
  bids_made: number
  bids_won?: number
  bids_attempted?: number
  stm_success?: number
  last_played_at: Date | null
  processed_hand_keys: string[] | unknown
  last_bid_attempt_hand_id: string | null
  last_bid_made_hand_id: string | null
}

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
  bidsAttempted: number
  bidsMade: number
  stmSuccess: number
  updatedAt: string
  processedHandKeys?: string[]
  lastBidAttemptHandId?: string
  lastBidMadeHandId?: string
  bidsWon?: number
}

/** Default stats when user has no row (all zeros, empty arrays). */
function defaultStats(userId: number): PersistedStats {
  return {
    userId,
    username: `user_${userId}`,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    bidsAttempted: 0,
    bidsMade: 0,
    stmSuccess: 0,
    updatedAt: '',
    processedHandKeys: [],
    bidsWon: 0,
  }
}

export async function getStats(userId: number): Promise<PersistedStats | null> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    const res: QueryResult<PlayerStatsRow> = await client.query(
      `SELECT user_id, games_played, games_won, hands_played, hands_won, bids_made, bids_won,
              bids_attempted, stm_success, last_played_at, processed_hand_keys,
              last_bid_attempt_hand_id, last_bid_made_hand_id
       FROM player_stats WHERE user_id = $1`,
      [userId]
    )
    const row = res.rows[0]
    if (!row) return null
    const updatedAt = row.last_played_at ? new Date(row.last_played_at).toISOString() : ''
    const rawKeys = row.processed_hand_keys
    const processedHandKeys = Array.isArray(rawKeys) ? rawKeys : (rawKeys && typeof rawKeys === 'object' ? (Array.isArray((rawKeys as any)?.elements) ? (rawKeys as any).elements : []) : [])
    return {
      userId: Number(row.user_id),
      username: `user_${row.user_id}`,
      gamesPlayed: Number(row.games_played) || 0,
      wins: Number(row.games_won) || 0,
      losses: (Number(row.games_played) || 0) - (Number(row.games_won) || 0),
      bidsAttempted: Number(row.bids_attempted) ?? 0,
      bidsMade: Number(row.bids_made) ?? 0,
      stmSuccess: Number(row.stm_success) ?? 0,
      updatedAt,
      processedHandKeys,
      lastBidAttemptHandId: row.last_bid_attempt_hand_id ?? undefined,
      lastBidMadeHandId: row.last_bid_made_hand_id ?? undefined,
      bidsWon: Number(row.bids_won) ?? 0,
    }
  } finally {
    client.release()
  }
}

export async function upsertAddGame(params: {
  userId: number
  username: string
  didWin: boolean
  handKey: string
  handId: string
  didAttempt: boolean
  didMake: boolean
  stmSuccess: number
}): Promise<PersistedStats> {
  const pool = getPool()
  const key = String(params.userId)

  const client = await pool.connect()
  return (async () =>
    client
      .query<PlayerStatsRow>(
        `SELECT user_id, games_played, games_won, bids_attempted, bids_made, stm_success,
                processed_hand_keys, last_bid_attempt_hand_id, last_bid_made_hand_id
         FROM player_stats WHERE user_id = $1`,
        [params.userId]
      )
      .then(async (res: QueryResult<PlayerStatsRow>) => {
        const row = res.rows[0]
        let processedKeys: string[] = []
        let lastAttemptHandId: string | null = null
        let lastMadeHandId: string | null = null
        let gamesPlayed = 0
        let gamesWon = 0
        let bidsAttempted = 0
        let bidsMade = 0
        let stmSuccess = 0

        if (row) {
          const rawKeys = row.processed_hand_keys
          processedKeys = Array.isArray(rawKeys) ? rawKeys : (rawKeys && typeof rawKeys === 'object' ? (Array.isArray((rawKeys as any)?.elements) ? (rawKeys as any).elements : []) : [])
          lastAttemptHandId = row.last_bid_attempt_hand_id
          lastMadeHandId = row.last_bid_made_hand_id
          gamesPlayed = Number(row.games_played) || 0
          gamesWon = Number(row.games_won) || 0
          bidsAttempted = Number(row.bids_attempted) ?? 0
          bidsMade = Number(row.bids_made) ?? 0
          stmSuccess = Number(row.stm_success) ?? 0
        }

        if (processedKeys.includes(params.handKey)) {
          console.log('[STATS] apply hand userId=%s handKey=%s skipped (already processed)', key, params.handKey)
          client.release()
          const stats = await getStats(params.userId)
          return stats ?? defaultStats(params.userId)
        }

        const countAttempt = params.didAttempt && lastAttemptHandId !== params.handId ? 1 : 0
        const countMade = params.didMake && lastMadeHandId !== params.handId ? 1 : 0
        bidsAttempted = Math.max(0, bidsAttempted + countAttempt)
        bidsMade = Math.max(0, Math.min(bidsMade + countMade, bidsAttempted))
        const nextProcessed = [...processedKeys, params.handKey].slice(-MAX_PROCESSED_HAND_KEYS)
        const nextBidAttemptHandId = countAttempt ? params.handId : lastAttemptHandId
        const nextBidMadeHandId = countMade ? params.handId : lastMadeHandId

        return client
          .query<Record<string, never>>(
            `INSERT INTO player_stats (
              user_id, games_played, games_won, hands_played, hands_won, bids_made, bids_won,
              bids_attempted, stm_success, last_played_at, processed_hand_keys,
              last_bid_attempt_hand_id, last_bid_made_hand_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10::jsonb, $11, $12)
            ON CONFLICT (user_id) DO UPDATE SET
              games_played = player_stats.games_played + $2,
              games_won = player_stats.games_won + $3,
              hands_played = player_stats.hands_played + 1,
              hands_won = player_stats.hands_won + $13,
              bids_made = player_stats.bids_made + $6,
              bids_won = player_stats.bids_won + $7,
              bids_attempted = player_stats.bids_attempted + $8,
              stm_success = player_stats.stm_success + $9,
              last_played_at = now(),
              processed_hand_keys = $10::jsonb,
              last_bid_attempt_hand_id = COALESCE($11, player_stats.last_bid_attempt_hand_id),
              last_bid_made_hand_id = COALESCE($12, player_stats.last_bid_made_hand_id)`,
            [
              params.userId,
              1,
              params.didWin ? 1 : 0,
              1,
              countMade,
              countMade,
              countMade,
              countAttempt,
              Math.max(0, params.stmSuccess ?? 0),
              JSON.stringify(nextProcessed),
              nextBidAttemptHandId,
              nextBidMadeHandId,
              countMade,
            ]
          )
          .then(async () => {
            client.release()
            console.log('[STATS] update userId=%s handKey=%s didWin=%s bidsAttempted+=%s bidsMade+=%s', key, params.handKey, params.didWin, countAttempt, countMade)
            const stats = await getStats(params.userId)
            return stats ?? defaultStats(params.userId)
          })
      })
      .catch((err: unknown) => {
        client.release()
        console.error('[STATS] upsertAddGame failed:', err instanceof Error ? err.message : err)
        throw err
      })
  )()
}
