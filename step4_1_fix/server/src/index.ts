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

import { getStats, upsertAddGame } from './stats/store'

type Room = {
  code: string
  state: GameState
  settings: GameSettings

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
  rematchReady: Set<number>
}

type StatePayload = {
  roomCode: string
  token: string
  playerIndex: number | null
  isHost: boolean
  occupied: boolean[]
  state: GameState
}

const app = express()

// Allow cookie based sessions from the browser client.
app.use(cors({ origin: true, credentials: true }))

// Basic hardening. Keeps defaults conservative.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}))
app.use(express.json())

// session-file-store is CommonJS; require keeps it compatible with tsx/tsconfig.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const FileStore = require('session-file-store')(session)
const sessionMiddleware = session({
  name: 'cuse_pitch_sid',
  secret: process.env.SESSION_SECRET || 'cuse_pitch_dev_secret',
  resave: false,
  saveUninitialized: false,
  // Persist sessions to disk so users stay logged in across server restarts.
  store: new FileStore({
    path: path.join(__dirname, '..', '..', '.sessions'),
    retries: 0,
    logFn: () => {},
  }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  },
})

app.use(sessionMiddleware)

// Rate limit auth endpoints to reduce brute force risk.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
})

app.use('/api/auth', authLimiter, buildAuthRouter())

app.get('/api/stats/me', (req, res) => {
  const user = (req as any)?.session?.user as SessionUser | undefined
  if (!user?.id) {
    res.status(401).json({ ok: false, error: 'Not logged in' })
    return
  }

  const stats = getStats(user.id)
  const gamesPlayed = stats?.gamesPlayed ?? 0
  const wins = stats?.wins ?? 0
  const losses = stats?.losses ?? 0
  const bidsWon = stats?.bidsWon ?? 0
  const bidsMade = stats?.bidsMade ?? 0
  const stmSuccess = stats?.stmSuccess ?? 0

  const winPct = gamesPlayed > 0 ? wins / gamesPlayed : 0
  const bidWinPct = bidsWon > 0 ? bidsMade / bidsWon : 0

  res.json({
    ok: true,
    user: { id: user.id, username: user.username },
    stats: {
      gamesPlayed,
      wins,
      losses,
      winPct,
      bidsWon,
      bidsMade,
      bidWinPct,
      stmSuccess,
      updatedAt: stats?.updatedAt ?? null,
    },
  })
})
app.get('/health', (_req, res) => res.json({ ok: true }))

// Client build output
const distPath = path.join(__dirname, '../../client/dist')
const hasClientBuild = fs.existsSync(path.join(distPath, 'index.html'))
if (hasClientBuild) {
  app.use(express.static(distPath))
}

const httpServer = http.createServer(app)
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
  // Mobile browsers can pause background tabs and miss heartbeats; a slightly longer timeout
  // reduces false disconnects and improves reconnect stability.
  pingInterval: 25000,
  pingTimeout: 45000,
})

// Share Express session with Socket.IO.
const wrap = (mw: any) => (socket: any, next: any) => mw(socket.request, {} as any, next)
io.use(wrap(sessionMiddleware))
io.use((socket, next) => {
  const user = (socket.request as any)?.session?.user as SessionUser | undefined
  ;(socket.data as any).user = user || null
  next()
})

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
    seatToken: new Map(),
    tokenSeat: new Map(),
    seatUserId: new Map(),
    tokenUserId: new Map(),
    socketsByToken: new Map(),
    tokenBySocketId: new Map(),
    hostToken,
    rematchReady: new Set(),
  }

  room.seatToken.set(0, hostToken)
  room.tokenSeat.set(hostToken, 0)

  if (hostUserId) {
    room.seatUserId.set(0, hostUserId)
    room.tokenUserId.set(hostToken, hostUserId)
  }

  return room
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

  // Show 6-card hands only once play starts
  if (clone.phase === 'PLAY' || clone.phase === 'HAND_END' || clone.phase === 'GAME_END') {
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
    isHost: token === room.hostToken,
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

function emitRoomState(room: Room): void {
  for (const token of room.socketsByToken.keys()) emitToToken(room, token)
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
  // host cannot leave seat 0
  if (token === room.hostToken) return
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

  if (action.type === 'START_HAND') return room.state.phase === 'SETUP' && pi === room.state.dealerIndex
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
  const getAuthed = () => (((socket.request as any)?.session?.user as SessionUser | undefined) || null)
  socket.on('createRoom', (payload: { settings: GameSettings, name: string, token?: string }, cb?: (resp: any) => void) => {
    try {
      const authed = getAuthed()
      const chosenName = (authed?.username || payload.name || 'Host').trim()
      const room = makeRoom(payload.settings, chosenName, authed?.id)
      rooms.set(room.code, room)

      attachSocketToToken(room, socket.id, room.hostToken)
      socket.join(room.code)

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

    const authed = (socket.data as any).user as SessionUser | null

    // If the user is logged in and already owns a seat in this room, prefer that seat's token.
    if (authed?.id) {
      for (const [s, uid] of room.seatUserId.entries()) {
        if (uid === authed.id) {
          const existing = room.seatToken.get(s)
          if (existing) token = existing
          break
        }
      }
      room.tokenUserId.set(token, authed.id)
    }

    attachSocketToToken(room, socket.id, token)
    socket.join(code)

    // Reclaim seat if token already owns one
    let seat = playerIndexForToken(room, token)

    // If no seat, keep as spectator (seat null). User can take a seat in lobby.
    // But if seat 0 is open and no one else is host, do not allow grabbing host seat.
    if (seat === null && !payload.spectate) {
      // optionally auto assign first open non-host seat
      const pc = room.state.players.length
      for (let i = 0; i < pc; i++) {
        if (i === 0) continue
        if (!room.seatToken.has(i)) { takeSeat(room, token, i); seat = i; break }
      }
    }

    // Set name only if seated and setup
    if (seat !== null && room.state.phase === 'SETUP') {
      const authed = (socket.data as any).user as SessionUser | null
      const chosenName = (authed?.username || payload.name || `Player ${seat + 1}`).trim()
      room.state = reducer(room.state, { type: 'SET_NAME', playerIndex: seat, name: chosenName })
    }

    emitRoomState(room)
    cb?.({ ok: true, roomCode: code, token, playerIndex: seat, isHost: token === room.hostToken })
  })

  socket.on('createInvite', (payload: { roomCode: string, token: string }, cb?: (resp: any) => void) => {
    const code = (payload.roomCode || '').toUpperCase().trim()
    const room = rooms.get(code)
    if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
    const authed = (socket.data as any).user as SessionUser | null
    const hostUserId = room.seatUserId.get(0) ?? null
    if (payload.token !== room.hostToken && (!authed?.id || authed.id !== hostUserId)) { cb?.({ ok: false, error: 'Host only' }); return }

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

    // Delegate to joinRoom behavior, but without requiring the client to know the room code.
    // This preserves existing networking contracts and seat assignment behavior.
    const code = inv.roomCode
    let token = genToken()
    const authed = getAuthed()

    // If the user is logged in and already owns a seat in this room, prefer that seat's token.
    if (authed?.id) {
      for (const [s, uid] of room.seatUserId.entries()) {
        if (uid === authed.id) {
          const existing = room.seatToken.get(s)
          if (existing) token = existing
          break
        }
      }
      room.tokenUserId.set(token, authed.id)
    }

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

    if (seat !== null && room.state.phase === 'SETUP') {
      const chosenName = (authed?.username || payload.name || `Player ${seat + 1}`).trim()
      room.state = reducer(room.state, { type: 'SET_NAME', playerIndex: seat, name: chosenName })
    }

    emitRoomState(room)
    cb?.({ ok: true, roomCode: code, token, playerIndex: seat, isHost: token === room.hostToken })
  })

  socket.on('reconnectRoom', (payload: { roomCode: string, token: string }, cb?: (resp: any) => void) => {
    const code = (payload.roomCode || '').toUpperCase().trim()
    const room = rooms.get(code)
    if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }

    const token = payload.token
    if (!token) { cb?.({ ok: false, error: 'Missing token' }); return }

    const authed = (socket.data as any).user as SessionUser | null
    const tokenUserId = room.tokenUserId.get(token)
    if (tokenUserId && authed?.id && tokenUserId !== authed.id) {
      cb?.({ ok: false, error: 'Token belongs to another user' }); return
    }

    attachSocketToToken(room, socket.id, token)
    socket.join(code)
    emitRoomState(room)

    cb?.({ ok: true, roomCode: code, token, playerIndex: playerIndexForToken(room, token), isHost: token === room.hostToken })
  })

  // Step 2: if the player is logged in, allow reconnecting a seat using the cookie session
  // even if the device lost its local token (refresh, cleared storage, etc).
  socket.on('reconnectRoomSession', (payload: { roomCode: string }, cb?: (resp: any) => void) => {
    const code = (payload.roomCode || '').toUpperCase().trim()
    const room = rooms.get(code)
    if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }

    const authed = (socket.data as any).user as SessionUser | null
    if (!authed?.id) { cb?.({ ok: false, error: 'Not logged in' }); return }

    // If this user already owns a seat in this room, reattach to that seat's token.
    let seat: number | null = null
    for (const [s, uid] of room.seatUserId.entries()) {
      if (uid === authed.id) { seat = s; break }
    }

    let token: string
    if (seat !== null) {
      token = room.seatToken.get(seat) || genToken()
      room.tokenUserId.set(token, authed.id)
      attachSocketToToken(room, socket.id, token)
    } else {
      // No seat: join as spectator, but still bind this socket to a token for future seat selection.
      token = genToken()
      room.tokenUserId.set(token, authed.id)
      attachSocketToToken(room, socket.id, token)
    }

    socket.join(code)
    emitRoomState(room)

    cb?.({ ok: true, roomCode: code, token, playerIndex: seat, isHost: token === room.hostToken })
  })

  socket.on('takeSeat', (payload: { roomCode: string, token: string, seat: number, name?: string }, cb?: (resp: any) => void) => {
    const code = (payload.roomCode || '').toUpperCase().trim()
    const room = rooms.get(code)
    if (!room) { cb?.({ ok: false, error: 'Room not found' }); return }
    if (room.state.phase !== 'SETUP') { cb?.({ ok: false, error: 'Seats can only be changed in Setup' }); return }

    // host token only can take seat 0
    if (payload.seat === 0 && payload.token !== room.hostToken) { cb?.({ ok: false, error: 'Seat 1 is host only' }); return }

    const res = takeSeat(room, payload.token, payload.seat)
    if (!res.ok) { cb?.(res); return }

    const authed = (socket.data as any).user as SessionUser | null
    if (authed?.id) {
      room.seatUserId.set(payload.seat, authed.id)
      room.tokenUserId.set(payload.token, authed.id)
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
    if (payload.token !== room.hostToken) { cb?.({ ok: false, error: 'Host only' }); return }
    if (room.state.phase !== 'SETUP') { cb?.({ ok: false, error: 'Kick only in Setup' }); return }
    if (payload.seat === 0) { cb?.({ ok: false, error: 'Cannot kick host' }); return }

    const seatToken = room.seatToken.get(payload.seat)
    if (seatToken) {
      room.seatToken.delete(payload.seat)
    room.rematchReady.delete(payload.seat)
      room.tokenSeat.delete(seatToken)
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
      // preserve names for occupied seats
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
    if (payload.token !== room.hostToken) { cb?.({ ok: false, error: 'Host only' }); return }

    // preserve names for occupied seats
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
    if (payload.token !== room.hostToken) { cb?.({ ok: false, error: 'Host only' }); return }

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
    if (payload.token !== room.hostToken) { cb?.({ ok: false, error: 'Host only' }); return }
    if (room.state.phase !== 'SETUP') { cb?.({ ok: false, error: 'Settings only in Setup' }); return }

    room.settings = payload.settings

    // Reset seating to match new player count
    const oldSeatToken = new Map(room.seatToken)
    room.seatToken.clear()
    room.tokenSeat.clear()

    // Host keeps seat 0
    room.seatToken.set(0, room.hostToken)
    room.tokenSeat.set(room.hostToken, 0)

    // Recreate game
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
    if (!isAuthorized(room, payload.token, payload.action)) { cb?.({ ok: false, error: 'Not authorized for that action right now' }); return }

    try {
      const prevState = room.state
      const nextState = reducer(room.state, payload.action)
      room.state = nextState

      // Step 3: Persist per-user lifetime stats exactly once when the server authoritative
      // reducer transitions into GAME_END (team reaches/surpasses target score).
      if (prevState.phase !== 'GAME_END' && nextState.phase === 'GAME_END' && nextState.winnerTeamId) {
        const winnerTeamId = nextState.winnerTeamId
        const seenUserIds = new Set<string>()

        for (const [seat, uidRaw] of room.seatUserId.entries()) {
          const uidStr = String(uidRaw)
          if (!uidStr || seenUserIds.has(uidStr)) continue
          seenUserIds.add(uidStr)

          const userId = Number(uidStr)
          if (!Number.isFinite(userId)) continue

          const player = nextState.players[seat]
          if (!player) continue

          const perGame = nextState.statsByPlayerId[player.id]
          const bidsWon = perGame?.bidsWon ?? 0
          const bidsMade = perGame?.bidsMade ?? 0
          const stmSuccess = perGame?.stmSuccess ?? 0

          const didWin = player.teamId === winnerTeamId
          const dbUser = getUserById(userId)
          const username = dbUser?.username ?? `user_${userId}`

          upsertAddGame({
            userId,
            username,
            didWin,
            bidsWon,
            bidsMade,
            stmSuccess,
          })
        }
      }

      emitRoomState(room)
      cb?.({ ok: true })
    } catch (e: any) {
      cb?.({ ok: false, error: e?.message ?? 'Action failed' })
    }
  })

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      detachSocket(room, socket.id)
      emitRoomState(room)
    }
  })
})

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001
if (hasClientBuild) {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}


httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})
