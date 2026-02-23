import type { QueryResult } from 'pg'

import { getPool } from '../db/pool'

const MAX_PROCESSED_HAND_KEYS = 200
const MIN_GAMES = 5

console.log('[STATS] store=Postgres (player_stats)')

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

export async function getStats(userId: number): Promise<PersistedStats> {
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
    if (!row) return defaultStats(userId)
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
  return (async (): Promise<PersistedStats> =>
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
        let stmSuccess = 0

        if (row) {
          const rawKeys = row.processed_hand_keys
          processedKeys = Array.isArray(rawKeys) ? rawKeys : (rawKeys && typeof rawKeys === 'object' ? (Array.isArray((rawKeys as any)?.elements) ? (rawKeys as any).elements : []) : [])
          lastAttemptHandId = row.last_bid_attempt_hand_id
          lastMadeHandId = row.last_bid_made_hand_id
          gamesPlayed = Number(row.games_played) || 0
          gamesWon = Number(row.games_won) || 0
          bidsAttempted = Number(row.bids_attempted) ?? 0
          stmSuccess = Number(row.stm_success) ?? 0
        }

        if (processedKeys.includes(params.handKey)) {
          console.log('[STATS] apply hand userId=%s handKey=%s skipped (already processed)', key, params.handKey)
          client.release()
          return getStats(params.userId)
        }

        const countAttempt = params.didAttempt && lastAttemptHandId !== params.handId ? 1 : 0
        const countMade = params.didMake && lastMadeHandId !== params.handId ? 1 : 0
        bidsAttempted = Math.max(0, bidsAttempted + countAttempt)
        const nextProcessed = [...processedKeys, params.handKey].slice(-MAX_PROCESSED_HAND_KEYS)
        const nextBidAttemptHandId = countAttempt ? params.handId : lastAttemptHandId
        const nextBidMadeHandId = countMade ? params.handId : lastMadeHandId

        return client
          .query<Record<string, never>>(
            `INSERT INTO player_stats (
              user_id, games_played, games_won, hands_played, hands_won, bids_made, bids_won,
              bids_attempted, stm_success, last_played_at, processed_hand_keys,
              last_bid_attempt_hand_id, last_bid_made_hand_id
            ) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7, now(), $8::jsonb, $9, $10)
            ON CONFLICT (user_id) DO UPDATE SET
              games_played = player_stats.games_played + $2,
              games_won = player_stats.games_won + $3,
              hands_played = player_stats.hands_played + 1,
              hands_won = player_stats.hands_won + $5,
              bids_attempted = player_stats.bids_attempted + $6,
              stm_success = player_stats.stm_success + $7,
              last_played_at = now(),
              processed_hand_keys = $8::jsonb,
              last_bid_attempt_hand_id = COALESCE($9, player_stats.last_bid_attempt_hand_id),
              last_bid_made_hand_id = COALESCE($10, player_stats.last_bid_made_hand_id)`,
            [
              params.userId,
              1,
              params.didWin ? 1 : 0,
              1,
              countMade,
              countAttempt,
              Math.max(0, params.stmSuccess ?? 0),
              JSON.stringify(nextProcessed),
              nextBidAttemptHandId,
              nextBidMadeHandId,
            ]
          )
          .then(async () => {
            client.release()
            console.log('[STATS] update userId=%s handKey=%s didWin=%s bidsAttempted+=%s', key, params.handKey, params.didWin, countAttempt)
            return getStats(params.userId)
          })
      })
      .catch((err: unknown) => {
        client.release()
        console.error('[STATS] upsertAddGame failed:', err instanceof Error ? err.message : err)
        throw err
      })
  )()
}

export type LeaderboardRow = {
  userId: number
  name: string
  games: number
  wins: number
  losses: number
  winPct: number
}

/** Top players by win percentage. Only players with games_played >= MIN_GAMES. Limit clamped 1..25. */
export async function getLeaderboard(limit: number): Promise<LeaderboardRow[]> {
  const pool = getPool()
  const client = await pool.connect()
  const clampedLimit = Math.min(25, Math.max(1, limit))
  try {
    const res = await client.query<{
      user_id: string
      username: string | null
      games_played: string
      games_won: string
    }>(
      `SELECT ps.user_id, u.username, ps.games_played, ps.games_won
       FROM player_stats ps
       JOIN users u ON u.id = ps.user_id
       WHERE ps.games_played >= $2
       ORDER BY (ps.games_won::float / NULLIF(ps.games_played, 0)) DESC,
                ps.games_played DESC,
                ps.games_won DESC
       LIMIT $1`,
      [clampedLimit, MIN_GAMES]
    )
    return res.rows.map((row) => {
      const games = Number(row.games_played) || 0
      const wins = Number(row.games_won) || 0
      const losses = games - wins
      const winPct = games > 0 ? wins / games : 0
      const name = (row.username && String(row.username).trim()) ? String(row.username).trim() : `User ${row.user_id}`
      return {
        userId: Number(row.user_id),
        name,
        games,
        wins,
        losses,
        winPct,
      }
    })
  } finally {
    client.release()
  }
}

/** Persist bids_made (one per bidder per hand) and bids_won (one per hand for winner). Idempotent via hand_bid_made/hand_bid_winner unique constraints. */
export async function persistBidsForHand(params: {
  roomCode: string
  handKey: string
  biddersUserId: number[]
  winnerUserId: number | null
}): Promise<void> {
  const { roomCode, handKey, biddersUserId, winnerUserId } = params
  const pool = getPool()
  const client = await pool.connect()
  try {
    let biddersCount = 0
    for (const userId of biddersUserId) {
      const res = await client.query(
        `INSERT INTO hand_bid_made (user_id, hand_key) VALUES ($1, $2)
         ON CONFLICT (user_id, hand_key) DO NOTHING RETURNING user_id`,
        [userId, handKey]
      )
      if (res.rowCount && res.rowCount > 0) {
        await client.query(
          `INSERT INTO player_stats (user_id, games_played, games_won, hands_played, hands_won, bids_made, bids_won, trump_calls, points_for, points_against, bids_attempted, stm_success, processed_hand_keys)
           VALUES ($1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, '[]'::jsonb)
           ON CONFLICT (user_id) DO UPDATE SET bids_made = player_stats.bids_made + 1`,
          [userId]
        )
        biddersCount++
      }
    }
    if (winnerUserId != null) {
      const res = await client.query(
        `INSERT INTO hand_bid_winner (hand_key, user_id) VALUES ($1, $2)
         ON CONFLICT (hand_key) DO NOTHING RETURNING user_id`,
        [handKey, winnerUserId]
      )
      if (res.rowCount && res.rowCount > 0) {
        await client.query(
          `INSERT INTO player_stats (user_id, games_played, games_won, hands_played, hands_won, bids_made, bids_won, trump_calls, points_for, points_against, bids_attempted, stm_success, processed_hand_keys)
           VALUES ($1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, '[]'::jsonb)
           ON CONFLICT (user_id) DO UPDATE SET bids_won = player_stats.bids_won + 1`,
          [winnerUserId]
        )
      }
    }
    console.log('[STATS] bids persisted room=%s handKey=%s biddersCount=%s winnerUserId=%s', roomCode, handKey, biddersCount, winnerUserId ?? 'null')
  } finally {
    client.release()
  }
}
