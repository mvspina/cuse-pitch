import express from 'express'
import path from 'path'
import fs from 'fs'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import http from 'http'
import { Server } from 'socket.io'
import session from 'express-session'

import { newGame, reducer } from './engine/game'
import type { Action, GameSettings, GameState } from './engine/types'

import { buildAuthRouter } from './auth/routes'
import { getUserById } from './auth/db'
import type { SessionUser } from './auth/db'

import { getStats, getLeaderboard, upsertAddGame, computeBidRate, persistBidsForHand } from './stats/store'

type Room = {
  code: string
  state: GameState
  settings: GameSettings

  // Stable hand key for current hand (set at START_HAND); used for bid persistence.
  currentHandKey: string | null
  // Incremented when entering SETUP after a game end; used in currentHandKey.
  gameSeq: number

  // Seat ownership
  seatToken: Map<number, string>          // seatIndex -> token
  tokenSeat: Map<string, number>          // token -> seatIndex

  // Optional account binding (Step 2)
  seatUserId: Map<number, string>         // seatIndex -> userId
  tokenUserId: Map<string, string>        // token -> userId

  // Socket tracking
  socketsByToken: Map<string, Set<string>> // token -> socketIds
  tokenBySocketId: Map<string, string>     // socketId -> token

  hostToken: string
  /** Stable host identity; used for host-only auth after socket reconnects. */
  hostUserId: string | null
  rematchReady: Set<number>

  // In-game chat (in memory, max 50 messages, no persistence)
  chatMessages: Array<{ id: string; ts: number; userId: number | null; name: string; text: string }>
  lastChatAtBySocketId: Map<string, number>
}

type StatePayload = {
  roomCode: string
  token: string
  playerIndex: number | null
  isHost: boolean
  occupied: boolean[]
  state: GameState
  rematchReady: boolean[]
}

/** Authoritative room snapshot for clients; stable identity (userId) and connected state. */
type RoomStateSnapshot = {
  roomCode: string
  hostUserId: string | null
  players: { userId: string; username: string; seatIndex: number | null; connected: boolean }[]
}

const app = express()

// Trust proxy first so secure cookies and X-Forwarded-* work behind Fly.io.
app.set('trust proxy', 1)

const ALLOWED_ORIGINS = new Set([
  'https://syracuse-pitch.fly.dev',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
])
const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true)
    if (process.env.NODE_ENV !== 'production') return cb(null, true)
    return cb(null, false)
  },
  credentials: true,
}
app.use(cors(corsOptions))

// Basic hardening. Keeps defaults conservative.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}))
app.use(express.json())

// Health endpoints first (before static or catch-all) so they always return JSON
app.get('/health', (_req, res) => res.status(200).json({ ok: true }))
app.get('/healthz', async (_req, res) => {
  try {
    const { pingDb } = await import('./db/pool')
    await pingDb(1000)
    res.status(200).json({ ok: true, env: process.env.NODE_ENV ?? 'unknown', ts: Date.now() })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Database unreachable'
    res.status(503).json({ ok: false, error: 'db_unreachable', message })
  }
})
if (process.env.NODE_ENV !== 'production') {
  app.get('/debug/email', (_req, res) => {
    const appBaseUrl = (process.env.APP_BASE_URL || '').trim() || (process.env.NODE_ENV === 'production' ? 'https://syracuse-pitch.fly.dev' : 'http://localhost:5173')
    res.status(200).json({
      smtpConfigured: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
      appBaseUrl,
      hasSmtpFrom: !!process.env.SMTP_FROM,
    })
  })
}

const isProduction = process.env.NODE_ENV === 'production'

async function runMigrationsOnly(): Promise<void> {
  const { runMigrations } = await import('./db/migrate')
  await runMigrations()
}

// Client build output: only in production so dev keeps using Vite
const clientDistPath = path.join(__dirname, '../../client/dist')
const hasClientBuild = fs.existsSync(path.join(clientDistPath, 'index.html'))
if (process.env.NODE_ENV === 'production' && hasClientBuild) {
  app.use(express.static(clientDistPath))
}

async function bootstrap(): Promise<void> {
  await runMigrationsOnly()

  const { getPool } = await import('./db/pool')
  const ConnectPgSession = require('connect-pg-simple')(session)
  const store = new ConnectPgSession({ pool: getPool() })
  const sessionMiddleware: express.RequestHandler = session({
    name: 'cuse_pitch_sid',
    secret: process.env.SESSION_SECRET || 'cuse_pitch_dev_secret',
    resave: false,
    saveUninitialized: false,
    store,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  })
  app.use(sessionMiddleware)

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
  app.use('/api/auth', authLimiter, buildAuthRouter())

  app.get('/api/stats/me', async (req, res) => {
    const user = (req as any)?.session?.user as SessionUser | undefined
    if (!user?.id) {
      res.status(401).json({ ok: false, error: 'Not logged in' })
      return
    }
    console.log('[STATS] profile stats requested userId=%s', user.id)
    const stats = await getStats(user.id)
    const gamesPlayed = stats.gamesPlayed ?? 0
    const wins = stats.wins ?? 0
    const losses = stats.losses ?? 0
    const bidsAttempted = stats.bidsAttempted ?? Math.max(stats.bidsMade ?? 0, stats.bidsWon ?? 0)
    const bidsMade = stats.bidsMade ?? 0
    const bidsWon = stats.bidsWon ?? 0
    const stmSuccess = stats.stmSuccess ?? 0

    const winPct = gamesPlayed > 0 ? Math.min(1, Math.max(0, wins / gamesPlayed)) : 0
    const bidWinPct = computeBidRate(bidsAttempted, bidsMade)
    if (process.env.NODE_ENV !== 'production' && (bidWinPct > 1 || Number.isNaN(bidWinPct))) {
      throw new Error(`invariant: bidWinPct must be in [0,1], got ${bidWinPct}`)
    }

    res.json({
      ok: true,
      user: { id: user.id, username: user.username },
      stats: {
        gamesPlayed,
        wins,
        losses,
        winPct,
        bidsAttempted,
        bidsMade,
        bidsWon,
        bidWinPct,
        stmSuccess,
        updatedAt: stats.updatedAt ?? null,
      },
    })
  })

  const httpServer = http.createServer(app)
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => {
        if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true)
        if (process.env.NODE_ENV !== 'production') return cb(null, true)
        return cb(null, false)
      },
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 45000,
  })

  // Share Express session with Socket.IO so handshake has req.session.
  const wrap = (mw: any) => (socket: any, next: any) => mw(socket.request, {} as any, next)
  io.use(wrap(sessionMiddleware))
  io.use((socket, next) => {
    const user = (socket.request as any)?.session?.user as SessionUser | undefined
    ;(socket.data as any).user = user || null
    if (user?.id != null) {
      console.log('[WS] handshake socketId=%s userId=%s', socket.id, user.id)
    } else {
      console.log('[WS] handshake socketId=%s no session (anonymous)', socket.id)
    }
    next()
  })

  /** Returns stable user id from socket auth/session, or null if not logged in. */
  function getSocketUserId(socket: any): string | null {
    const user = (socket?.data as any)?.user as SessionUser | undefined
    return user?.id != null ? String(user.id) : null
  }

  const rooms = new Map<string, Room>()

  type Invite = { code: string, roomCode: string, createdAt: number }
  const invites = new Map<string, Invite>()
  const invitesByRoom = new Map<string, Set<string>>()

  function genInviteCode(len = 8): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let out = ''
    for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
    return out
  }

  function addInvite(roomCode: string): Invite {
    // Prefer a stable invite per room (reuse the first one) so hosts can share it repeatedly.
    const existing = invitesByRoom.get(roomCode)
    if (existing && existing.size > 0) {
      const first = existing.values().next().value as string
      const inv = invites.get(first)
      if (inv) return inv
    }
    let code = genInviteCode()
    while (invites.has(code)) code = genInviteCode()
    const inv: Invite = { code, roomCode, createdAt: Date.now() }
    invites.set(code, inv)
    if (!invitesByRoom.has(roomCode)) invitesByRoom.set(roomCode, new Set())
    invitesByRoom.get(roomCode)!.add(code)
    return inv
  }

  function deleteInvitesForRoom(roomCode: string): void {
    const set = invitesByRoom.get(roomCode)
    if (!set) return
    for (const code of set) invites.delete(code)
    invitesByRoom.delete(roomCode)
  }

  function genRoomCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = ''
    for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)]
    return code
  }

  function genToken(): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let t = ''
    for (let i = 0; i < 22; i++) t += alphabet[Math.floor(Math.random() * alphabet.length)]
    return t
  }

  function makeRoom(settings: GameSettings, hostName: string, hostUserId?: string): Room {
    const code = genRoomCode()
    const hostToken = genToken()

    let state = newGame(settings, [])
    state = reducer(state, { type: 'SET_NAME', playerIndex: 0, name: hostName || 'Host' })

    const room: Room = {
      code,
      state,
      settings,
      currentHandKey: null,
      gameSeq: 1,
      seatToken: new Map(),
      tokenSeat: new Map(),
      seatUserId: new Map(),
      tokenUserId: new Map(),
      socketsByToken: new Map(),
      tokenBySocketId: new Map(),
      hostToken,
      hostUserId: hostUserId ?? null,
      rematchReady: new Set(),
      chatMessages: [],
      lastChatAtBySocketId: new Map(),
    }

    room.seatToken.set(0, hostToken)
    room.tokenSeat.set(hostToken, 0)

    if (hostUserId) {
      room.seatUserId.set(0, hostUserId)
      room.tokenUserId.set(hostToken, hostUserId)
    }

    return room
  }

  /** True if this token (or its userId) is the room host. Resilient to reconnect. */
  function isHost(room: Room, token: string): boolean {
    if (token === room.hostToken) return true
    if (room.hostUserId != null && room.tokenUserId.get(token) === room.hostUserId) return true
    return false
  }

  function occupiedArray(room: Room): boolean[] {
    const pc = room.state.players.length
    const occ: boolean[] = Array.from({ length: pc }, () => false)
    for (const [seat] of room.seatToken.entries()) occ[seat] = true
    return occ
  }
  
  function playerIndexForToken(room: Room, token: string): number | null {
    const seat = room.tokenSeat.get(token)
    return (seat === undefined) ? null : seat
  }

  function maskStateForPlayer(state: GameState, playerIndex: number | null): GameState {
    const clone: GameState = JSON.parse(JSON.stringify(state))
    const pc = clone.players.length

    const keepIndex = (playerIndex === null) ? -1 : playerIndex
  
    // Always hide other players' hands
    clone.hands7 = state.hands7.map((h, i) => (i === keepIndex ? h : []))
    clone.dealtHands7 = state.dealtHands7.map((h, i) => (i === keepIndex ? h : []))
    clone.discardPiles = state.discardPiles.map((h, i) => (i === keepIndex ? h : []))
  
    // Show 6-card hands only once play starts (PLAY), through scoring (SCORE_HAND), to game end (GAME_END)
    if (clone.phase === 'PLAY' || clone.phase === 'SCORE_HAND' || clone.phase === 'GAME_END') {
      clone.hands6 = state.hands6.map((h, i) => (i === keepIndex ? h : []))
    } else {
      clone.hands6 = Array.from({ length: pc }, () => [])
    }
  
    return clone
  }
  
  function emitToToken(room: Room, token: string): void {
    const socketIds = room.socketsByToken.get(token)
    if (!socketIds || socketIds.size === 0) return
  
    const pi = playerIndexForToken(room, token)
    const masked = maskStateForPlayer(room.state, pi)
  
    const payload: StatePayload = {
      roomCode: room.code,
      token,
      playerIndex: pi,
      isHost: isHost(room, token),
      occupied: occupiedArray(room),
      state: masked,
      rematchReady: (() => {
        const pc = room.state.players.length
        const arr = Array(pc).fill(false)
        for (const seat of room.rematchReady) {
          if (seat >= 0 && seat < pc) arr[seat] = true
        }
        return arr
      })(),
    }
  
    for (const sid of socketIds) {
      const sock = io.sockets.sockets.get(sid)
      if (sock) sock.emit('state', payload)
    }
  }
  
  function buildRoomStateSnapshot(room: Room): RoomStateSnapshot {
    const pc = room.state.players.length
    const players: RoomStateSnapshot['players'] = []
    for (let seat = 0; seat < pc; seat++) {
      const userId = room.seatUserId.get(seat)
      if (userId == null) continue
      const token = room.seatToken.get(seat)
      const connected = !!(token && room.socketsByToken.get(token)?.size)
      players.push({
        userId: String(userId),
        username: room.state.players[seat]?.name ?? (seat === 0 ? 'Host' : `Player ${seat + 1}`),
        seatIndex: seat,
        connected,
      })
    }
    return { roomCode: room.code, hostUserId: room.hostUserId, players }
  }
  
  function emitRoomState(room: Room): void {
    for (const token of room.socketsByToken.keys()) emitToToken(room, token)
    io.to(room.code).emit('room:state', buildRoomStateSnapshot(room))
  }
  
  function attachSocketToToken(room: Room, socketId: string, token: string): void {
    room.tokenBySocketId.set(socketId, token)
    if (!room.socketsByToken.has(token)) room.socketsByToken.set(token, new Set())
    room.socketsByToken.get(token)!.add(socketId)
  }
  
  function detachSocket(room: Room, socketId: string): void {
    const token = room.tokenBySocketId.get(socketId)
    if (!token) return
    room.tokenBySocketId.delete(socketId)
    const set = room.socketsByToken.get(token)
    if (set) {
      set.delete(socketId)
      if (set.size === 0) room.socketsByToken.delete(token)
    }
  }
  
  function takeSeat(room: Room, token: string, seat: number): { ok: boolean, error?: string } {
    const pc = room.state.players.length
    if (seat < 0 || seat >= pc) return { ok: false, error: 'Invalid seat' }
    if (room.seatToken.has(seat)) return { ok: false, error: 'Seat already taken' }
  
    // If token already has a seat, free it
    const currentSeat = room.tokenSeat.get(token)
    if (currentSeat !== undefined) {
      room.seatToken.delete(currentSeat)
      room.rematchReady.delete(currentSeat)
      room.tokenSeat.delete(token)
      room.seatUserId.delete(currentSeat)
    }
  
    room.seatToken.set(seat, token)
    room.tokenSeat.set(token, seat)
    return { ok: true }
  }
  
  function leaveSeat(room: Room, token: string): void {
    const seat = room.tokenSeat.get(token)
    if (seat === undefined) return
    if (isHost(room, token)) return
    room.seatToken.delete(seat)
        room.rematchReady.delete(seat)
    room.tokenSeat.delete(token)
    room.seatUserId.delete(seat)
  }
  
  function isAuthorized(room: Room, token: string, action: Action): boolean {
    const pi = playerIndexForToken(room, token)
    if (pi === null) return false
  
    if (action.type === 'SET_NAME') return action.playerIndex === pi && room.state.phase === 'SETUP'
    if (action.type === 'SET_PLAYERCOUNT' || action.type === 'SET_TARGET' || action.type === 'NEW_GAME') return false
  
    if (action.type === 'START_HAND') {
      const ok = room.state.phase === 'SETUP' && pi === room.state.dealerIndex
      return ok
    }
    if (action.type === 'PLACE_BID') return room.state.phase === 'BIDDING' && pi === room.state.currentBidderIndex
    if (action.type === 'TAKE_OUT') return room.state.phase === 'BIDDING' && pi === room.state.currentBidderIndex
    if (action.type === 'MULLIGAN_7') return room.state.phase === 'BIDDING' && pi === action.playerIndex
    if (action.type === 'DEALER_SET_TRUMP') return room.state.phase === 'DEALER_TRUMP' && pi === room.state.dealerIndex
    if (action.type === 'TOGGLE_DISCARD') return room.state.phase === 'DISCARD' && !room.state.discardDone[pi]
    if (action.type === 'CONFIRM_DISCARD') return room.state.phase === 'DISCARD' && !room.state.discardDone[pi]
    if (action.type === 'REDEAL_TO_6') return room.state.phase === 'DISCARD' && pi === room.state.dealerIndex && pi === room.state.currentPlayerIndex
    if (action.type === 'PLAY_CARD') return room.state.phase === 'PLAY' && pi === room.state.currentPlayerIndex
    if (action.type === 'APPLY_SCORE_AND_NEXT_HAND') return room.state.phase === 'SCORE_HAND' && pi === room.state.dealerIndex
  
    return false
  }
  
  io.on('connection', (socket) => {
    const uid = getSocketUserId(socket)
    console.log('[WS] connect socketId=%s userId=%s', socket.id, uid ?? 'anonymous')
    if (!uid) {
      console.log('[WS] socket anonymous - stats will not be persisted for this connection; user must log in via HTTP first')
    }
    const getAuthed = () => (((socket.request as any)?.session?.user as SessionUser | undefined) || null)
    socket.on('createRoom', (payload: { settings: GameSettings, name: string, token?: string }, cb?: (resp: any) => void) => {
      try {
        const authed = getAuthed()
        const authedId = authed?.id != null ? String(authed.id) : undefined
        const chosenName = (authed?.username || payload.name || 'Host').trim()
        const room = makeRoom(payload.settings, chosenName, authedId)
        rooms.set(room.code, room)
  
        attachSocketToToken(room, socket.id, room.hostToken)
        socket.join(room.code)
        if (authedId) console.log('[ROOM] assign host room=%s hostUserId=%s', room.code, authedId)
  
        emitRoomState(room)
        cb?.({ ok: true, roomCode: room.code, token: room.hostToken, playerIndex: 0, isHost: true })
      } catch (e: any) {
        cb?.({ ok: false, error: e?.message ?? 'createRoom failed' })
      }
    })
  
    socket.on('joinRoom', (payload: { roomCode: string, name: string, token?: string, spectate?: boolean }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }

      let token = payload.token && payload.token.length > 10 ? payload.token : genToken()
      let hostReconnected = false
      let reclaimedSeat = false

      const authed = (socket.data as any).user as SessionUser | null
      const authedId = authed?.id != null ? String(authed.id) : undefined

      // Reconnect path: if this user is the host (by userId), always assign hostToken and seat 0 so host auth survives reconnect.
      if (authedId && room.hostUserId != null && authedId === room.hostUserId) {
        hostReconnected = true
        token = room.hostToken
        room.tokenUserId.set(token, authedId)
        const at0 = room.seatToken.get(0)
        if (at0 !== token) {
          if (at0) {
            room.seatToken.delete(0)
            room.tokenSeat.delete(at0)
            room.seatUserId.delete(0)
            const sids = room.socketsByToken.get(at0)
            if (sids) {
              for (const sid of sids) room.tokenBySocketId.delete(sid)
              room.socketsByToken.delete(at0)
            }
          }
          room.seatToken.set(0, token)
          room.tokenSeat.set(token, 0)
          room.seatUserId.set(0, authedId)
        }
        console.log('[ROOM] join room=%s host reconnected userId=%s', code, authedId)
      } else if (authedId) {
        // If the user is logged in and already owns a seat in this room, prefer that seat's token.
        for (const [s, uid] of room.seatUserId.entries()) {
          if (uid === authedId) {
            const existing = room.seatToken.get(s)
            if (existing) { token = existing; reclaimedSeat = true }
            break
          }
        }
        room.tokenUserId.set(token, authedId)
      }
      if (!room.hostUserId && authedId) room.hostUserId = authedId
  
      attachSocketToToken(room, socket.id, token)
      socket.join(code)
  
      // Reclaim seat if token already owns one
      let seat = playerIndexForToken(room, token)
  
      // If no seat, keep as spectator (seat null). User can take a seat in lobby.
      if (seat === null && !payload.spectate) {
        const pc = room.state.players.length
        for (let i = 0; i < pc; i++) {
          if (i === 0) continue
          if (!room.seatToken.has(i)) { takeSeat(room, token, i); seat = i; break }
        }
      }
      // Always bind seat -> userId when seated and authenticated (join or reconnect with token that had a seat).
      if (seat !== null && authedId) {
        room.seatUserId.set(seat, authedId)
        room.tokenUserId.set(token, authedId)
      }
  
      // Set name only if seated and setup
      if (seat !== null && room.state.phase === 'SETUP') {
        const chosenName = (authed?.username || payload.name || `Player ${seat + 1}`).trim()
        room.state = reducer(room.state, { type: 'SET_NAME', playerIndex: seat, name: chosenName })
      }

      if (seat !== null && !hostReconnected && !reclaimedSeat) {
        const displayName = room.state.players[seat]?.name ?? `Player ${seat + 1}`
        emitSystem(code, room, `${displayName} joined the table (Seat ${seat + 1}).`)
      }

      console.log('[ROOM] join room=%s token=%s seat=%s userId=%s isHost=%s', code, token.slice(0, 8) + '…', seat, authedId ?? 'anonymous', isHost(room, token))
      emitRoomState(room)
      cb?.({ ok: true, roomCode: code, token, playerIndex: seat, isHost: isHost(room, token) })
    })
  
    socket.on('createInvite', (payload: { roomCode: string, token: string }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
      if (!isHost(room, payload.token)) {
        const userId = getSocketUserId(socket) ?? room.tokenUserId.get(payload.token) ?? null
        console.log('[ROOM] host-only denied createInvite room=%s userId=%s hostUserId=%s', code, userId, room.hostUserId)
        cb?.({ ok: false, error: 'Host only' }); return
      }
  
      const inv = addInvite(code)
      cb?.({ ok: true, inviteCode: inv.code, roomCode: code })
    })
  
    socket.on('joinInvite', (payload: { inviteCode: string, name: string, spectate?: boolean }, cb?: (resp: any) => void) => {
      const inviteCode = (payload.inviteCode || '').toUpperCase().trim()
      const inv = invites.get(inviteCode)
      if (!inv) { cb?.({ ok: false, error: 'Invite not found or expired' }); return }
      const room = rooms.get(inv.roomCode)
      if (!room) {
        // Room is gone, clean up invite
        invites.delete(inviteCode)
        const set = invitesByRoom.get(inv.roomCode)
        set?.delete(inviteCode)
        if (set && set.size === 0) invitesByRoom.delete(inv.roomCode)
        cb?.({ ok: false, error: 'Invite not found or expired' })
        return
      }
  
      const code = inv.roomCode
      let token = genToken()
      const authed = getAuthed()
      const authedId = authed?.id != null ? String(authed.id) : undefined
  
      // Host reconnect: if this user is the host by userId, assign hostToken and seat 0.
      if (authedId && room.hostUserId != null && authedId === room.hostUserId) {
        token = room.hostToken
        room.tokenUserId.set(token, authedId)
        const at0 = room.seatToken.get(0)
        if (at0 !== token) {
          if (at0) {
            room.seatToken.delete(0)
            room.tokenSeat.delete(at0)
            room.seatUserId.delete(0)
            const sids = room.socketsByToken.get(at0)
            if (sids) {
              for (const sid of sids) room.tokenBySocketId.delete(sid)
              room.socketsByToken.delete(at0)
            }
          }
          room.seatToken.set(0, token)
          room.tokenSeat.set(token, 0)
          room.seatUserId.set(0, authedId)
        }
        console.log('[ROOM] join room=%s (invite) host reconnected userId=%s', code, authedId)
      } else if (authedId) {
        for (const [s, uid] of room.seatUserId.entries()) {
          if (uid === authedId) {
            const existing = room.seatToken.get(s)
            if (existing) token = existing
            break
          }
        }
        room.tokenUserId.set(token, authedId)
      }
      if (!room.hostUserId && authedId) room.hostUserId = authedId
  
      attachSocketToToken(room, socket.id, token)
      socket.join(code)
  
      let seat = playerIndexForToken(room, token)
      if (seat === null && !payload.spectate) {
        const pc = room.state.players.length
        for (let i = 0; i < pc; i++) {
          if (i === 0) continue
          if (!room.seatToken.has(i)) { takeSeat(room, token, i); seat = i; break }
        }
      }
      if (seat !== null && authedId) {
        room.seatUserId.set(seat, authedId)
        room.tokenUserId.set(token, authedId)
      }
  
      if (seat !== null && room.state.phase === 'SETUP') {
        const chosenName = (authed?.username || payload.name || `Player ${seat + 1}`).trim()
        room.state = reducer(room.state, { type: 'SET_NAME', playerIndex: seat, name: chosenName })
      }
  
      console.log('[ROOM] join (invite) room=%s token=%s seat=%s userId=%s isHost=%s', code, token.slice(0, 8) + '…', seat, authedId ?? 'anonymous', isHost(room, token))
      emitRoomState(room)
      cb?.({ ok: true, roomCode: code, token, playerIndex: seat, isHost: isHost(room, token) })
    })
  
    socket.on('reconnectRoom', (payload: { roomCode: string, token: string }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
  
      const token = payload.token
      if (!token) { cb?.({ ok: false, error: 'Missing token' }); return }
  
      const authed = (socket.data as any).user as SessionUser | null
      const authedId = authed?.id != null ? String(authed.id) : undefined
      const tokenUserId = room.tokenUserId.get(token)
      if (tokenUserId && authedId && tokenUserId !== authedId) {
        cb?.({ ok: false, error: 'Token belongs to another user' }); return
      }
  
      attachSocketToToken(room, socket.id, token)
      socket.join(code)
      const seat = playerIndexForToken(room, token)
      if (seat !== null && authedId) {
        room.seatUserId.set(seat, authedId)
        room.tokenUserId.set(token, authedId)
      }
      console.log('[ROOM] reconnect room=%s token=%s seat=%s userId=%s isHost=%s', code, token.slice(0, 8) + '…', seat, authedId ?? 'anonymous', isHost(room, token))
      emitRoomState(room)
  
      cb?.({ ok: true, roomCode: code, token, playerIndex: playerIndexForToken(room, token), isHost: isHost(room, token) })
    })
  
    // Step 2: if the player is logged in, allow reconnecting a seat using the cookie session
    // even if the device lost its local token (refresh, cleared storage, etc).
    socket.on('reconnectRoomSession', (payload: { roomCode: string }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
  
      const authed = (socket.data as any).user as SessionUser | null
      const authedId = authed?.id != null ? String(authed.id) : undefined
      if (!authedId) { cb?.({ ok: false, error: 'Not logged in' }); return }
  
      // If this user already owns a seat in this room, reattach to that seat's token.
      let seat: number | null = null
      for (const [s, uid] of room.seatUserId.entries()) {
        if (uid === authedId) { seat = s; break }
      }
  
      let token: string
      if (seat !== null) {
        token = room.seatToken.get(seat) || genToken()
        room.tokenUserId.set(token, authedId)
        attachSocketToToken(room, socket.id, token)
      } else {
        // No seat: join as spectator, but still bind this socket to a token for future seat selection.
        token = genToken()
        room.tokenUserId.set(token, authedId)
        attachSocketToToken(room, socket.id, token)
      }
  
      socket.join(code)
      console.log('[ROOM] reconnect (session) room=%s userId=%s seat=%s isHost=%s', code, authedId, seat, isHost(room, token))
      emitRoomState(room)
  
      cb?.({ ok: true, roomCode: code, token, playerIndex: seat, isHost: isHost(room, token) })
    })

    socket.on('leaveRoom', (payload: { roomCode: string }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const userId = getSocketUserId(socket) ?? 'anonymous'
      console.log('[ROOM] room:leave userId=%s roomCode=%s socketId=%s', userId, code || '(empty)', socket.id)
      if (!code) {
        console.log('[ROOM] room:leave failed userId=%s roomCode=%s error=missing roomCode', userId, code)
        cb?.({ ok: false, error: 'Room code required' })
        return
      }
      const room = rooms.get(code)
      if (!room) {
        console.log('[ROOM] room:leave failed userId=%s roomCode=%s error=room not found', userId, code)
        cb?.({ ok: false, error: 'Room not found' })
        return
      }
      const token = room.tokenBySocketId.get(socket.id)
      if (!token) {
        console.log('[ROOM] room:leave failed userId=%s roomCode=%s error=not in room', userId, code)
        cb?.({ ok: false, error: 'Not in room' })
        return
      }
      const seat = room.tokenSeat.get(token)
      const leaveName = (seat != null && room.state.players[seat]?.name) ? room.state.players[seat].name : null
      detachSocket(room, socket.id)
      socket.leave(code)
      emitRoomState(room)
      emitSystem(code, room, leaveName ? `${leaveName} left the table.` : 'A player left the table.')
      console.log('[ROOM] room:leave success userId=%s roomCode=%s', userId, code)
      cb?.({ ok: true })
    })

    type ChatMsg = { id: string; ts: number; userId: number | null; name: string; text: string }
    function addChatMessage(room: Room, message: ChatMsg) {
      room.chatMessages = room.chatMessages ?? []
      room.chatMessages.push(message)
      if (room.chatMessages.length > 50) room.chatMessages = room.chatMessages.slice(-50)
    }
    function makeSystemMessage(text: string): ChatMsg {
      return {
        id: `${Date.now()}-${Math.random()}`,
        ts: Date.now(),
        userId: null,
        name: 'System',
        text,
      }
    }
    function emitSystem(roomCode: string, room: Room, text: string) {
      const msg = makeSystemMessage(text)
      addChatMessage(room, msg)
      io.to(roomCode).emit('chat:message', { roomCode, message: msg })
      console.log('[CHAT] system room=%s text=%s', roomCode, text)
    }

    socket.on('chat:send', (payload: { roomCode: string; text: string }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) {
        cb?.({ ok: false, error: 'Room not found' })
        return
      }
      const token = room.tokenBySocketId.get(socket.id)
      if (!token) {
        cb?.({ ok: false, error: 'Not in room' })
        return
      }
      const rawText = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (rawText.length < 1 || rawText.length > 200) {
        cb?.({ ok: false, error: 'Message must be 1–200 characters' })
        return
      }
      const now = Date.now()
      const lastAt = room.lastChatAtBySocketId.get(socket.id) ?? 0
      if (now - lastAt < 1000) {
        cb?.({ ok: false, error: 'rate_limited' })
        return
      }
      room.lastChatAtBySocketId.set(socket.id, now)
      const uidStr = getSocketUserId(socket)
      const userIdNum = uidStr != null ? parseInt(uidStr, 10) : null
      const userId = Number.isFinite(userIdNum) ? userIdNum : null
      const seat = room.tokenSeat.get(token)
      const name = (seat != null && room.state.players[seat]?.name)
        ? room.state.players[seat].name
        : (userId != null ? `User ${userId}` : 'Guest')
      const message = {
        id: `${now}-${Math.random()}`,
        ts: now,
        userId,
        name,
        text: rawText,
      }
      room.chatMessages.push(message)
      if (room.chatMessages.length > 50) room.chatMessages = room.chatMessages.slice(-50)
      console.log('[CHAT] send room=%s userId=%s name=%s len=%s', code, userId ?? 'guest', name, rawText.length)
      io.to(code).emit('chat:message', { roomCode: code, message })
      console.log('[CHAT] broadcast room=%s total=%s', code, room.chatMessages.length)
      cb?.({ ok: true })
    })

    socket.on('chat:history', (payload: { roomCode: string }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) {
        cb?.({ ok: false, error: 'Room not found' })
        return
      }
      const token = room.tokenBySocketId.get(socket.id)
      if (!token) {
        cb?.({ ok: false, error: 'Not in room' })
        return
      }
      cb?.({ ok: true, messages: room.chatMessages ?? [] })
    })

    socket.on('leaderboard:get', async (payload: { limit?: number }, cb?: (resp: any) => void) => {
      const userId = getSocketUserId(socket)
      if (!userId) {
        cb?.({ ok: false, error: 'unauthorized' })
        return
      }
      const limit = Math.min(25, Math.max(1, payload?.limit ?? 10))
      console.log('[STATS] leaderboard requested userId=%s limit=%s', userId, limit)
      try {
        const rows = await getLeaderboard(limit)
        console.log('[STATS] leaderboard success count=%s', rows.length)
        cb?.({ ok: true, rows })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[STATS] leaderboard failed error=%s', msg)
        cb?.({ ok: false, error: 'leaderboard failed' })
      }
    })

    socket.on('takeSeat', (payload: { roomCode: string, token: string, seat: number, name?: string }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
      if (room.state.phase !== 'SETUP') { cb?.({ ok: false, error: 'Seats can only be changed in Setup' }); return }
  
      if (payload.seat === 0 && !isHost(room, payload.token)) { cb?.({ ok: false, error: 'Seat 1 is host only' }); return }
  
      const res = takeSeat(room, payload.token, payload.seat)
      if (!res.ok) { cb?.(res); return }
  
      const authed = (socket.data as any).user as SessionUser | null
      const authedId = authed?.id != null ? String(authed.id) : undefined
      if (authedId) {
        room.seatUserId.set(payload.seat, authedId)
        room.tokenUserId.set(payload.token, authedId)
        console.log('[ROOM] seat assignment room=%s seat=%s userId=%s', code, payload.seat, authedId)
      }
      const chosenName = (authed?.username || payload.name || '').trim()
      if (chosenName.length > 0) {
        room.state = reducer(room.state, { type: 'SET_NAME', playerIndex: payload.seat, name: chosenName })
      }
  
      emitRoomState(room)
      cb?.({ ok: true, playerIndex: payload.seat })
    })
  
    socket.on('leaveSeat', (payload: { roomCode: string, token: string }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
      if (room.state.phase !== 'SETUP') { cb?.({ ok: false, error: 'Seats can only be changed in Setup' }); return }
  
      leaveSeat(room, payload.token)
      emitRoomState(room)
      cb?.({ ok: true, playerIndex: playerIndexForToken(room, payload.token) })
    })
  
    socket.on('hostKick', (payload: { roomCode: string, token: string, seat: number }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
      if (!isHost(room, payload.token)) {
        console.log('[ROOM] host-only denied hostKick room=%s userId=%s hostUserId=%s', code, getSocketUserId(socket) ?? room.tokenUserId.get(payload.token), room.hostUserId)
        cb?.({ ok: false, error: 'Host only' }); return
      }
      if (room.state.phase !== 'SETUP') { cb?.({ ok: false, error: 'Kick only in Setup' }); return }
      if (payload.seat === 0) { cb?.({ ok: false, error: 'Cannot kick host' }); return }

      const seatToken = room.seatToken.get(payload.seat)
      const targetUserId = room.seatUserId.get(payload.seat) ?? null
      const hostUserId = room.hostUserId ?? room.tokenUserId.get(payload.token) ?? null
      console.log('[KICK] requested by hostUserId=%s targetUserId=%s room=%s', hostUserId, targetUserId, code)

      if (seatToken) {
        room.seatToken.delete(payload.seat)
        room.rematchReady.delete(payload.seat)
        room.tokenSeat.delete(seatToken)
        room.seatUserId.delete(payload.seat)
        const kickedSocketIds = room.socketsByToken.get(seatToken)
        if (kickedSocketIds) {
          for (const sid of kickedSocketIds) {
            const sock = io.sockets.sockets.get(sid)
            if (sock) sock.emit('kicked')
          }
        }
      }
      emitRoomState(room)
      cb?.({ ok: true })
    })
  
  
    socket.on('rematchReady', (payload: { roomCode: string, token: string, ready: boolean }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
      if (room.state.phase !== 'GAME_END') { cb?.({ ok: false, error: 'Rematch only after game end' }); return }
  
      const seat = playerIndexForToken(room, payload.token)
      if (seat === null || seat === undefined) { cb?.({ ok: false, error: 'Seat not found' }); return }
  
      const occupied = room.seatToken.has(seat)
      if (!occupied) { cb?.({ ok: false, error: 'Not seated' }); return }
  
      if (payload.ready) room.rematchReady.add(seat)
      else room.rematchReady.delete(seat)
  
      // If all occupied seats are ready, start a new game (hostless ready-up)
      const pc = room.state.players.length
      let allReady = true
      for (let i = 0; i < pc; i++) {
        if (room.seatToken.has(i)) {
          if (!room.rematchReady.has(i)) { allReady = false; break }
        }
      }
  
      if (allReady) {
        room.gameSeq += 1
        room.currentHandKey = null
        const names: string[] = room.state.players.map(p => p.name)
        room.state = newGame(room.settings, [])
        room.rematchReady.clear()
        for (let i = 0; i < room.state.players.length; i++) {
          const seatTok = room.seatToken.get(i)
          if (seatTok) {
            const nm = names[i] || (i === 0 ? 'Host' : `Player ${i + 1}`)
            room.state = reducer(room.state, { type: 'SET_NAME', playerIndex: i, name: nm })
          }
        }
      }
  
      emitRoomState(room)
      cb?.({ ok: true, started: allReady })
    })
  
    socket.on('hostReset', (payload: { roomCode: string, token: string }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
      if (!isHost(room, payload.token)) {
        console.log('[ROOM] host-only denied hostReset room=%s userId=%s hostUserId=%s', code, getSocketUserId(socket) ?? room.tokenUserId.get(payload.token), room.hostUserId)
        cb?.({ ok: false, error: 'Host only' }); return
      }

      room.gameSeq += 1
      room.currentHandKey = null
      const names: string[] = room.state.players.map(p => p.name)
      room.state = newGame(room.settings, [])
      room.rematchReady.clear()
      for (let i = 0; i < room.state.players.length; i++) {
        const seatTok = room.seatToken.get(i)
        if (seatTok) {
          const nm = names[i] || (i === 0 ? 'Host' : `Player ${i + 1}`)
          room.state = reducer(room.state, { type: 'SET_NAME', playerIndex: i, name: nm })
        }
      }

      emitRoomState(room)
      cb?.({ ok: true })
    })
    socket.on('hostEndRoom', (payload: { roomCode: string, token: string }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
      if (!isHost(room, payload.token)) {
        console.log('[ROOM] host-only denied hostEndRoom room=%s userId=%s hostUserId=%s', code, getSocketUserId(socket) ?? room.tokenUserId.get(payload.token), room.hostUserId)
        cb?.({ ok: false, error: 'Host only' }); return
      }
  
      // Notify all connected clients, then delete the room
      const message = 'Host ended the room'
      for (const tok of room.socketsByToken.keys()) {
        const socketIds = room.socketsByToken.get(tok)
        if (!socketIds) continue
        for (const sid of socketIds) {
          io.to(sid).emit('roomEnded', { message })
        }
      }
      deleteInvitesForRoom(code)
      rooms.delete(code)
      cb?.({ ok: true })
    })
  
  
  
    socket.on('hostUpdateSettings', (payload: { roomCode: string, token: string, settings: GameSettings }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
      if (!isHost(room, payload.token)) {
        console.log('[ROOM] host-only denied hostUpdateSettings room=%s userId=%s hostUserId=%s', code, getSocketUserId(socket) ?? room.tokenUserId.get(payload.token), room.hostUserId)
        cb?.({ ok: false, error: 'Host only' }); return
      }
      if (room.state.phase !== 'SETUP') { cb?.({ ok: false, error: 'Settings only in Setup' }); return }
  
      room.settings = payload.settings
      room.gameSeq += 1
      room.currentHandKey = null

      const oldSeatToken = new Map(room.seatToken)
      room.seatToken.clear()
      room.tokenSeat.clear()

      room.seatToken.set(0, room.hostToken)
      room.tokenSeat.set(room.hostToken, 0)

      room.state = newGame(payload.settings, [])
      room.state = reducer(room.state, { type: 'SET_NAME', playerIndex: 0, name: room.state.players[0].name })
  
      // Try to re-seat existing tokens into first available seats (excluding host)
      const tokensToReseat = Array.from(oldSeatToken.entries())
        .filter(([seat, tok]) => seat !== 0 && tok !== room.hostToken)
        .map(([, tok]) => tok)
  
      let seatIdx = 1
      for (const tok of tokensToReseat) {
        if (seatIdx >= room.state.players.length) break
        room.seatToken.set(seatIdx, tok)
        room.tokenSeat.set(tok, seatIdx)
        seatIdx++
      }
  
      emitRoomState(room)
      cb?.({ ok: true })
    })
  
    socket.on('action', (payload: { roomCode: string, token: string, action: Action }, cb?: (resp: any) => void) => {
      const code = (payload.roomCode || '').toUpperCase().trim()
      const room = rooms.get(code)
      if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
  
      if (!payload.token) { cb?.({ ok: false, error: 'Missing token' }); return }
      if (!isAuthorized(room, payload.token, payload.action)) {
        if (payload.action.type === 'START_HAND') {
          const pi = playerIndexForToken(room, payload.token)
          console.log('[ROOM] action denied START_HAND room=%s userId=%s hostUserId=%s playerIndex=%s dealerIndex=%s phase=%s',
            code, getSocketUserId(socket) ?? room.tokenUserId.get(payload.token), room.hostUserId, pi, room.state.dealerIndex, room.state.phase)
        }
        cb?.({ ok: false, error: 'Not authorized for that action right now' }); return
      }
  
      try {
        const prevState = room.state
        const nextState = reducer(room.state, payload.action)
        room.state = nextState

        if (prevState.phase === 'GAME_END' && nextState.phase === 'SETUP') {
          room.gameSeq += 1
        }

        if (payload.action.type === 'START_HAND') {
          room.currentHandKey = `${code}:${room.gameSeq}:${nextState.handNumber}`
          console.log('[HAND] start room=%s handKey=%s dealer=%s handNumber=%s', code, room.currentHandKey, nextState.dealerIndex, nextState.handNumber)
        }

        if (payload.action.type === 'PLACE_BID' && payload.action.bid !== 'PASS') {
          const bidderSeat = prevState.currentBidderIndex
          const userId = bidderSeat != null ? room.seatUserId.get(bidderSeat) : undefined
          console.log('[BID] made room=%s handKey=%s userId=%s', code, room.currentHandKey ?? '', userId ?? 'anonymous')
        }

        if (prevState.phase === 'BIDDING' && (nextState.phase === 'DEALER_TRUMP' || nextState.phase === 'DISCARD')) {
          const handKey = room.currentHandKey ?? `${code}:${room.gameSeq}:${nextState.handNumber}`
          const nonPass = nextState.bidHistory.filter(b => b.bid !== 'PASS')
          const biddersUserId = [...new Set(nonPass.map(b => room.seatUserId.get(b.playerIndex))).values()]
            .filter((u): u is string => u != null && u !== '')
            .map(u => Number(u))
            .filter(n => Number.isFinite(n))
          const winnerSeat = nextState.bidWinnerIndex
          const winnerUserId = winnerSeat != null ? room.seatUserId.get(winnerSeat) : undefined
          const winnerId = winnerUserId != null && winnerUserId !== '' ? Number(winnerUserId) : null
          if (Number.isFinite(winnerId)) {
            console.log('[BID] winner room=%s handKey=%s userId=%s bid=%s', code, handKey, winnerId, nextState.winningBid ?? '')
          }
          persistBidsForHand({ roomCode: code, handKey, biddersUserId, winnerUserId: Number.isFinite(winnerId) ? winnerId : null }).catch((err) =>
            console.error('[STATS] persistBidsForHand failed:', err instanceof Error ? err.message : err)
          )
        }

        // Step 3: Persist per-user lifetime stats exactly once when the server authoritative
        // reducer transitions into GAME_END (team reaches/surpasses target score).
        // Keys use stable userId (from session / seatUserId), not socketId or username.
        if (prevState.phase !== 'GAME_END' && nextState.phase === 'GAME_END' && nextState.winnerTeamId) {
          const winnerTeamId = nextState.winnerTeamId
          const seenUserIds = new Set<string>()
          const handKey = room.currentHandKey ?? `${code}:${room.gameSeq}:${nextState.handNumber}:${winnerTeamId}`
          const handId = nextState.handId ?? handKey
          const lastResult = nextState.lastHandResult
          const bidderSeat = lastResult?.bidderPlayerIndex ?? null
          const didMakeBid = lastResult ? (lastResult.bidderMadeBid || lastResult.stmSucceeded) : false
  
          const seatToUserId = Object.fromEntries(Array.from(room.seatUserId.entries()).map(([s, u]) => [String(s), u]))
          const uniqueUserIds = [...new Set(room.seatUserId.values())].map(String).filter(Boolean)
          console.log('[STATS] game ended room=%s winnerTeamId=%s seat->userId=%s persisting userIds=%s', code, winnerTeamId, JSON.stringify(seatToUserId), JSON.stringify(uniqueUserIds))
          if (uniqueUserIds.length === 0) {
            console.warn('[STATS] no authenticated users in room (seatUserId empty) - stats will not be persisted; ensure players log in before joining')
          }
  
          const updates: Promise<unknown>[] = []
          for (const [seat, uidRaw] of room.seatUserId.entries()) {
            const uidStr = String(uidRaw)
            if (!uidStr || seenUserIds.has(uidStr)) continue
            seenUserIds.add(uidStr)
  
            const userId = Number(uidStr)
            if (!Number.isFinite(userId)) {
              console.log('[STATS] skip seat=%s userId invalid (not a number)', seat)
              continue
            }
  
            const player = nextState.players[seat]
            if (!player) {
              console.log('[STATS] skip userId=%s seat=%s no player', uidStr, seat)
              continue
            }
  
            const perGame = nextState.statsByPlayerId[player.id]
            const stmSuccess = perGame?.stmSuccess ?? 0
  
            const didWin = player.teamId === winnerTeamId
            const didAttempt = bidderSeat !== null && seat === bidderSeat
            const didMake = didAttempt && didMakeBid
  
            updates.push(
              (async () => {
                const dbUser = await getUserById(userId)
                const username = dbUser?.username ?? `user_${userId}`
                await upsertAddGame({
                  userId,
                  username,
                  didWin,
                  stmSuccess,
                  handKey,
                  handId,
                  didAttempt,
                  didMake,
                })
              })()
            )
          }
          if (updates.length > 0) {
            Promise.all(updates).catch((err) => console.error('[STATS] game-end persist failed:', err?.message ?? err))
          }
        }
  
        emitRoomState(room)
        cb?.({ ok: true })
      } catch (e: any) {
        cb?.({ ok: false, error: e?.message ?? 'Action failed' })
      }
    })
  
    socket.on('disconnect', () => {
      console.log('[WS] disconnect socketId=%s userId=%s', socket.id, getSocketUserId(socket) ?? 'anonymous')
      for (const room of rooms.values()) {
        detachSocket(room, socket.id)
        emitRoomState(room)
      }
    })
  })
  
  const HOST = '0.0.0.0'
  const PORT = Number(process.env.PORT) || 3000
  
  if (process.env.NODE_ENV === 'production' && hasClientBuild) {
    app.get('*', (req, res, next) => {
      if (req.method !== 'GET') return next()
      const accept = req.headers.accept ?? ''
      if (!accept.includes('text/html')) return next()
      if (req.path === '/health' || req.path === '/healthz' || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next()
      res.sendFile(path.join(clientDistPath, 'index.html'))
    })
  }

  httpServer.listen(PORT, HOST, () => {
    const env = process.env.NODE_ENV || 'development'
    const addr = httpServer.address()
    const bound = addr && typeof addr === 'object' ? `${addr.address}:${addr.port}` : ''
    let buildStamp = 'none'
    try {
      const stampPath = path.join(__dirname, '..', 'build-stamp.json')
      const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')) as { timestamp?: string }
      buildStamp = stamp?.timestamp ?? 'unknown'
    } catch { /* ignore */ }
    console.log(`Server listening on http://${HOST}:${PORT} (${env}) NODE_ENV=${process.env.NODE_ENV ?? ''} PORT=${PORT} HOST=${HOST} bound=${bound} build=${buildStamp}`)
  })
}

bootstrap().catch((err: unknown) => {
  console.error('[DB] startup failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
