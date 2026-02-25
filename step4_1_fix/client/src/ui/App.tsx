import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import { cardKey, currentHighBid, suitLabel, suitSymbol } from '../engine/game'
import type { Action, BidKind, Card, GameSettings, GameState, Suit } from '../engine/types'
import LeaderboardPanel from './LeaderboardPanel'
import ChatPanel from './ChatPanel'

type LeaderboardRow = { userId: number; name: string; games: number; wins: number; losses: number; winPct: number }

type ChatMessage = { id: string; ts: number; userId?: number | null; name: string; text: string }

const suitOptions: Suit[] = ['S','H','D','C']
const TOKEN_KEY = 'cuse-pitch-token'
const ROOM_KEY = 'cuse-pitch-room'
const PENDING_JOIN_ROOM = 'cuse-pitch-pending-join-room'
const SFX_KEY = 'cuse-pitch-sfx-enabled'
const AUTH_USER_KEY = 'cuse-pitch-auth-user'

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6D2B79F5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function Confetti({ seed, active }: { seed: number, active: boolean }) {
  const pieces = useMemo(() => {
    const rnd = mulberry32(seed)
    const count = 90
    return Array.from({ length: count }).map((_, i) => {
      const left = Math.floor(rnd() * 100)
      const delayMs = Math.floor(rnd() * 650)
      const durMs = 2200 + Math.floor(rnd() * 1200)
      const rot = Math.floor(rnd() * 360)
      const drift = (rnd() - 0.5) * 260
      const size = 10 + Math.floor(rnd() * 10)
      const variant = i % 8
      return { left, delayMs, durMs, rot, drift, size, variant }
    })
  }, [seed])

  if (!active) return null
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, idx) => (
        <span
          key={idx}
          className={`confettiPiece v${p.variant}`}
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: Math.max(4, Math.floor(p.size * 0.55)),
            animationDelay: `${p.delayMs}ms`,
            animationDuration: `${p.durMs}ms`,
            transform: `translateX(${p.drift}px) rotate(${p.rot}deg)`
          }}
        />
      ))}
    </div>
  )
}


function useSfx () {
  const [enabled, setEnabled] = useState(() => {
    const v = localStorage.getItem(SFX_KEY)
    return v == null ? true : v === '1'
  })

  const ctxRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    localStorage.setItem(SFX_KEY, enabled ? '1' : '0')
  }, [enabled])

  const unlock = React.useCallback(async () => {
    try {
      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
      if (!AudioCtx) return
      if (!ctxRef.current) ctxRef.current = new AudioCtx()
      if (ctxRef.current.state === 'suspended') {
        await ctxRef.current.resume()
      }
    } catch {}
  }, [])
  useEffect(() => {
    // Unlock once on first user interaction so game-triggered sounds work reliably.
    const onFirst = () => { void unlock() }
    window.addEventListener('pointerdown', onFirst, { once: true })
    window.addEventListener('keydown', onFirst, { once: true })
    return () => {
      window.removeEventListener('pointerdown', onFirst)
      window.removeEventListener('keydown', onFirst)
    }
  }, [unlock])



  const play = React.useCallback((kind: 'tap' | 'collect' | 'trump') => {
    if (!enabled) return
    const ctx = ctxRef.current
    if (!ctx) return
    if (ctx.state !== 'running') return

    const now = ctx.currentTime

    const mkTone = (freq: number, dur: number, vol: number, type: OscillatorType = 'sine', startAt = now) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = type
      osc.frequency.value = freq

      // Smooth, subtle envelope
      gain.gain.setValueAtTime(0.0001, startAt)
      gain.gain.exponentialRampToValueAtTime(vol, startAt + 0.006)
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur)

      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.start(startAt)
      osc.stop(startAt + dur + 0.01)
    }

    // Digital, understated UI sounds
    if (kind === 'tap') {
      mkTone(880, 0.055, 0.025, 'triangle')
    } else if (kind === 'collect') {
      mkTone(523.25, 0.10, 0.020, 'sine')
      mkTone(659.25, 0.10, 0.018, 'sine', now + 0.045)
    } else {
      // trump
      mkTone(740, 0.11, 0.022, 'sine')
      mkTone(988, 0.08, 0.012, 'triangle', now + 0.03)
    }
  }, [enabled])

  return { enabled, setEnabled, play, unlock }
}



function bidLabel(b: BidKind): string {
  if (b === 'PASS') return 'Pass'
  if (b === 'STM') return 'Shoot The Moon'
  return `Bid ${b}`
}

function strength(b: Exclude<BidKind,'PASS'>): number { return b === 'STM' ? 5 : b }
function cardText(c: Card): string { return `${c.rank}${suitSymbol[c.suit]}` }
function isRedSuit(s: Suit): boolean { return s === 'H' || s === 'D' }

function winnerNudge(playerCount: number, winnerIndex: number): { x: number, y: number } {
  // Make trick capture feel like the winner is actually collecting the cards.
  const n = playerCount
  if (n === 2) return winnerIndex === 0 ? { x: 0, y: -64 } : { x: 0, y: 64 }
  if (n === 3) {
    if (winnerIndex === 0) return { x: 0, y: -64 }
    if (winnerIndex === 1) return { x: -64, y: 44 }
    return { x: 64, y: 44 }
  }
  if (n === 4) {
    if (winnerIndex === 0) return { x: 0, y: -64 }
    if (winnerIndex === 1) return { x: 64, y: 0 }
    if (winnerIndex === 2) return { x: 0, y: 64 }
    return { x: -64, y: 0 }
  }
  if (n === 6) {
    if (winnerIndex === 0) return { x: 0, y: -64 }
    if (winnerIndex === 1) return { x: 78, y: -38 }
    if (winnerIndex === 2) return { x: 78, y: 38 }
    if (winnerIndex === 3) return { x: 0, y: 64 }
    if (winnerIndex === 4) return { x: -78, y: 38 }
    return { x: -78, y: -38 }
  }
  return { x: 0, y: 0 }
}

function legalPlays(hand: Card[], leadSuit: Suit | null, trump: Suit | null, mustLeadTrump: boolean): Card[] {
  if (mustLeadTrump && trump) {
    const hasTrump = hand.some(c => c.suit === trump)
    return hasTrump ? hand.filter(c => c.suit === trump) : hand
  }
  if (!leadSuit) return hand
  const hasLead = hand.some(c => c.suit === leadSuit)
  if (!hasLead) return hand
  // House rule: Trump is always playable, even when you can follow suit.
  // So the legal set is: all lead-suit cards, plus any trump cards.
  if (!trump) return hand.filter(c => c.suit === leadSuit)
  return hand.filter(c => c.suit === leadSuit || c.suit === trump)
}

function sameCard(a: Card, b: Card): boolean { return a.suit === b.suit && a.rank === b.rank }

function teamRosterLabel(state: GameState, teamId: string): string {
  const members = state.players.filter(p => p.teamId === teamId).map(p => (p.name || '').trim()).filter(Boolean)
  if (!members.length) return state.teams.find(t => t.id === teamId)?.name ?? teamId
  if (members.length === 1) return members[0]
  if (members.length === 2) return `${members[0]} & ${members[1]}`
  return members.join(', ')
}

function categoryName(c: string): string {
  if (c === 'HIGH') return 'High'
  if (c === 'LOW') return 'Low'
  if (c === 'JACK') return 'Jack'
  return 'Game'
}

function seatStyle(index: number, count: number): React.CSSProperties {
  const pos: Record<number, Record<number, React.CSSProperties>> = {
    2: { 0: { left: '50%', bottom: 10, transform: 'translateX(-50%)' }, 1: { left: '50%', top: 10, transform: 'translateX(-50%)' } },
    3: { 0: { left: 10, bottom: 10 }, 1: { right: 10, bottom: 10 }, 2: { left: '50%', top: 10, transform: 'translateX(-50%)' } },
    4: { 0: { left: '50%', bottom: 10, transform: 'translateX(-50%)' }, 1: { right: 10, top: '50%', transform: 'translateY(-50%)' }, 2: { left: '50%', top: 10, transform: 'translateX(-50%)' }, 3: { left: 10, top: '50%', transform: 'translateY(-50%)' } },
    6: { 0: { left: '50%', bottom: 10, transform: 'translateX(-50%)' }, 1: { right: 10, bottom: 40 }, 2: { right: 10, top: 40 }, 3: { left: '50%', top: 10, transform: 'translateX(-50%)' }, 4: { left: 10, top: 40 }, 5: { left: 10, bottom: 40 } },
  }
  return pos[count]?.[index] ?? { left: 10, top: 10 }
}

type RoomStateSnapshot = {
  roomCode: string
  hostUserId: string | null
  players: { userId: string; username: string; seatIndex: number | null; connected: boolean }[]
}

type NetState = {
  socket: Socket | null
  connected: boolean
  roomCode: string
  token: string
  playerIndex: number | null
  isHost: boolean
  occupied: boolean[]
  rematchReady: boolean[]
  roomState: RoomStateSnapshot | null
  error: string | null
  kickedMessage?: string
}

type AuthUser = {
  id: number
  username: string
}


type ProfileStats = {
  gamesPlayed: number
  wins: number
  losses: number
  winPct: number
  bidsWon: number
  bidsMade: number
  bidWinPct: number
  stmSuccess: number
  updatedAt: string | null
}

type MeStatsResponse = {
  ok: boolean
  error?: string
  user?: AuthUser
  stats?: ProfileStats
}

function pct(v: number): string {
  if (!isFinite(v) || v <= 0) return '0%'
  return `${Math.round(v * 1000) / 10}%`
}

function previewTeamForSeat(playerCount: number, seat: number): number {
  if (playerCount === 2) return 0

  if (playerCount === 3) return seat

  if (playerCount === 4) {
    // opposite seats are teammates
    return seat % 2
  }

  if (playerCount === 6) {
    // A B C A B C
    return seat % 3
  }

  return 0
}

function teamClassForSeat(playerCount: number, seat: number): string {
  return `teamTint${previewTeamForSeat(playerCount, seat)}`
}

export default function App() {
  const [settings, setSettings] = useState<GameSettings>({ targetScore: 11, playerCount: 4 })
  const sfx = useSfx()

  const [authUser, setAuthUser] = useState<AuthUser | null>(() => {
    try {
      const raw = localStorage.getItem(AUTH_USER_KEY)
      if (!raw) return null
      const u = JSON.parse(raw) as AuthUser
      return u?.username ? u : null
    } catch {
      return null
    }
  })
  const [authMode, setAuthMode] = useState<null | 'login' | 'signup' | 'resetRequest' | 'resetConfirm'>(null)
  const [authUsername, setAuthUsername] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [resetToken, setResetToken] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  const [net, setNet] = useState<NetState>({
    socket: null, connected: false, roomCode: '', token: '', playerIndex: null, isHost: false, occupied: [], rematchReady: [], roomState: null, error: null
  })
  const [state, setState] = useState<GameState | null>(null)

  const [myName, setMyName] = useState('Player')
  const [joinCode, setJoinCode] = useState('')
  const [watchOnly, setWatchOnly] = useState<boolean>(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      return params.get('spectate') === '1'
    } catch {
      return false
    }
  })
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(() => {
    try {
      const path = window.location.pathname || ''
      let code: string | null = null
      const m = path.match(/^\/join\/([A-Za-z0-9_-]{4,32})\/?$/)
      if (m?.[1]) code = m[1]
      if (!code) {
        const params = new URLSearchParams(window.location.search)
        const q = params.get('join')
        if (q) code = q
      }
      return code ? code.toUpperCase() : null
    } catch {
      return null
    }
  })

  const [autoJoinStatus, setAutoJoinStatus] = useState<'idle' | 'joining' | 'failed' | 'success'>('idle')
  const [autoJoinError, setAutoJoinError] = useState<string>('')
  const autoJoinStartedRef = useRef(false)
  const joinCodeInputRef = useRef<HTMLInputElement>(null)

  const isAuthed = Boolean(authUser?.id)

  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const inviteShareSupported = useMemo(() => typeof (navigator as any)?.share === 'function', [])
  const [profileOpen, setProfileOpen] = useState(false)
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileStats, setProfileStats] = useState<ProfileStats | null>(null)

  const [homeBusy, setHomeBusy] = useState<null | 'create' | 'join'>(null)
  const [homeToast, setHomeToast] = useState<string | null>(null)
  const [leaderboardRows, setLeaderboardRows] = useState<LeaderboardRow[]>([])
  const [leaderboardLoading, setLeaderboardLoading] = useState(false)
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null)
  const leaderboardFetchedRef = useRef(false)
  const [bidSuit, setBidSuit] = useState<Suit>('S')
  const [showHistory, setShowHistory] = useState(false)
  const [showPlayers, setShowPlayers] = useState(false)
  const [lingerTrickPlays, setLingerTrickPlays] = useState<{ playerIndex: number, card: Card }[]>([])
  const [lingerUntil, setLingerUntil] = useState(0)
  const [lingerWinnerIndex, setLingerWinnerIndex] = useState<number | null>(null)
  const [lingerLeaderIndex, setLingerLeaderIndex] = useState<number | null>(null)
  const [lingerAnim, setLingerAnim] = useState<'hold'|'slide'>('hold')
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 900)
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 900)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatLoading, setChatLoading] = useState(false)
  const chatLoadedForRoomRef = useRef<string | null>(null)

  const [discardSelectedIds, setDiscardSelectedIds] = useState<Set<string>>(() => new Set())
  const [discardHandLocal, setDiscardHandLocal] = useState<Card[]>([])
  const [discardPileLocal, setDiscardPileLocal] = useState<Card[]>([])
  const discardLocalInitializedRef = useRef(false)
  const lastDiscardHandSigRef = useRef<string>('')
  const lastPhaseRef = useRef<string>('')
  const [discardSubmitting, setDiscardSubmitting] = useState(false)

  const apiBase = useMemo(() => {
    return window.location.origin
  }, [])

  useEffect(() => {
    const phase = state?.phase
    const pi = net.playerIndex
    if (phase === 'DISCARD' && pi !== null && !discardLocalInitializedRef.current) {
      const serverHand = state.hands7?.[pi]
      const dealt = state.dealtHands7?.[pi]
      const source = (serverHand?.length ? serverHand : dealt) ?? []
      setDiscardHandLocal(source.map(c => ({ ...c })))
      setDiscardPileLocal([])
      setDiscardSelectedIds(new Set())
      discardLocalInitializedRef.current = true
    }
    if (phase !== 'DISCARD') {
      discardLocalInitializedRef.current = false
      setDiscardHandLocal([])
      setDiscardPileLocal([])
    }
  }, [state?.phase, state?.hands7, state?.dealtHands7, net.playerIndex])

  useEffect(() => {
    if (state?.phase !== 'DISCARD') setDiscardSubmitting(false)
    const pi = net.playerIndex
    if (state?.phase === 'DISCARD' && pi !== null && state.discardDone?.[pi]) setDiscardSubmitting(false)
  }, [state?.phase, state?.discardDone, net.playerIndex])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    if (localStorage.getItem('DEBUG_JOIN') === '1') {
      console.log('[JOINLINK] path=', window.location.pathname, 'code=', pendingInviteCode)
    }
  }, [pendingInviteCode])

  useEffect(() => {
    try {
      const path = (typeof window !== 'undefined' && window.location.pathname) || ''
      const m = path.match(/^\/join\/([A-Za-z0-9]{5})\/?$/i)
      if (m?.[1]) {
        const code = m[1].toUpperCase()
        localStorage.setItem(PENDING_JOIN_ROOM, code)
      }
    } catch {}
  }, [])

  useEffect(() => {
    if (isAuthed) return
    const fromStorage = typeof localStorage !== 'undefined' ? localStorage.getItem(PENDING_JOIN_ROOM) : null
    const hasPending = !!(pendingInviteCode || (fromStorage && fromStorage.trim()))
    if (hasPending && !authMode) setAuthMode('login')
  }, [isAuthed, pendingInviteCode, authMode])



  async function authFetch(path: string, opts?: RequestInit) {
    const res = await fetch(`${apiBase}${path}`, {
      ...(opts || {}),
      headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
      credentials: 'include',
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error || 'Request failed')
    return data
  }

  useEffect(() => {
    void (async () => {
      try {
        const data = await authFetch('/api/auth/me')
        const u = data?.user as AuthUser | null
        if (u?.username) {
          setAuthUser(u)
          setMyName(u.username)
          localStorage.setItem(AUTH_USER_KEY, JSON.stringify(u))
        } else {
          localStorage.removeItem(AUTH_USER_KEY)
          setAuthUser(null)
        }
      } catch {
        localStorage.removeItem(AUTH_USER_KEY)
        setAuthUser(null)
      }
    })()
  }, [])

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const t = params.get('reset')
      if (!t) return
      setResetToken(t)
      setAuthMode('resetConfirm')
      params.delete('reset')
      const next = params.toString()
      const base = window.location.pathname
      window.history.replaceState({}, '', next ? `${base}?${next}` : base)
    } catch {
      // ignore
    }
  }, [])

  async function doAuthSubmit() {
    if (!authMode || authMode === 'resetRequest' || authMode === 'resetConfirm') return
    setAuthBusy(true)
    setAuthError(null)
    try {
      const payload: any = { username: authUsername, password: authPassword }
      if (authMode === 'signup') payload.email = authEmail
      const data = await authFetch(`/api/auth/${authMode}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const u = data?.user as AuthUser | null
      if (u?.username) {
        setAuthUser(u)
        setMyName(u.username)
        localStorage.setItem(AUTH_USER_KEY, JSON.stringify(u))
        setAuthMode(null)
        setAuthPassword('')
        try {
          const pending = localStorage.getItem(PENDING_JOIN_ROOM)
          if (pending && pending.trim()) setPendingInviteCode(pending.trim().toUpperCase())
        } catch {}
      }
    } catch (e: any) {
      setAuthError(e?.message || 'Auth failed')
    } finally {
      setAuthBusy(false)
    }
  }

  async function doResetRequest() {
    setAuthBusy(true)
    setAuthError(null)
    try {
      await authFetch('/api/auth/password-reset/request', {
        method: 'POST',
        body: JSON.stringify({ email: authEmail }),
      })
      setAuthError('If that email exists, a reset link has been sent.')
    } catch (e: any) {
      setAuthError(e?.message || 'Reset request failed')
    } finally {
      setAuthBusy(false)
    }
  }

  async function doResetConfirm() {
    setAuthBusy(true)
    setAuthError(null)
    try {
      const token = resetToken.trim()
      if (!token) throw new Error('Reset token is required.')
      await authFetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        body: JSON.stringify({ token, password: authPassword }),
      })
      setAuthPassword('')
      setResetToken('')
      setAuthMode('login')
      setAuthError('Password updated. Please log in.')
    } catch (e: any) {
      setAuthError(e?.message || 'Password reset failed')
    } finally {
      setAuthBusy(false)
    }
  }

  async function doLogout() {
    setAuthBusy(true)
    setAuthError(null)
    try {
      await authFetch('/api/auth/logout', { method: 'POST' })
      localStorage.removeItem(AUTH_USER_KEY)
      setAuthUser(null)
      setAuthMode(null)
    } catch (e: any) {
      setAuthError(e?.message || 'Logout failed')
    } finally {
      setAuthBusy(false)
    }
  }

    async function loadProfileStats() {
    if (!authUser) return
    setProfileBusy(true)
    setProfileError(null)
    try {
      const data = await authFetch('/api/stats/me') as MeStatsResponse
      if (!data?.ok) throw new Error(data?.error || 'Failed to load stats')
      setProfileStats(data.stats || null)
    } catch (e: any) {
      setProfileError(e?.message || 'Failed to load stats')
    } finally {
      setProfileBusy(false)
    }
  }

  function openProfile() {
    setProfileOpen(true)
    void loadProfileStats()
  }
  useEffect(() => {
    if (state?.phase === 'GAME_END' && authUser) void loadProfileStats()
  }, [state?.phase, authUser?.id])

const prevPlaysLenRef = useRef<number>(0)
  const prevTrickCountRef = useRef<number>(0)
  const prevTrumpRef = useRef<Suit | null>(null)

  useEffect(() => {
    const liveLen = state?.currentTrick?.plays?.length ?? 0
    if (liveLen > prevPlaysLenRef.current) {
      sfx.play('tap')
    }
    prevPlaysLenRef.current = liveLen
  }, [state?.currentTrick?.plays?.length, sfx])

  useEffect(() => {
    const count = state?.trickHistory?.length ?? 0
    if (count > prevTrickCountRef.current) {
      sfx.play('collect')
    }
    prevTrickCountRef.current = count
  }, [state?.trickHistory?.length, sfx])

  useEffect(() => {
    const t = state?.trump ?? null
    if (t && prevTrumpRef.current !== t) {
      sfx.play('trump')
    }
    prevTrumpRef.current = t
  }, [state?.trump, sfx])

  const [hudScoresAnim, setHudScoresAnim] = useState<Record<string, number>>({})
  const [hudSetsAnim, setHudSetsAnim] = useState<Record<string, number>>({})
  const [flashTeamScore, setFlashTeamScore] = useState<Record<string, boolean>>({})
  const [flashTeamSets, setFlashTeamSets] = useState<Record<string, boolean>>({})
  const [flashTrump, setFlashTrump] = useState(false)
  const [trumpRippleTick, setTrumpRippleTick] = useState(0)

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const t = params.get('t')
      if (t && typeof t === 'string' && t.length > 10 && !localStorage.getItem(TOKEN_KEY)) {
        localStorage.setItem(TOKEN_KEY, t)
      }
    } catch {}

    const serverUrl = (import.meta.env.VITE_SOCKET_URL as string | undefined)?.trim() || window.location.origin
    const s = io(serverUrl, { transports: ['websocket', 'polling'], withCredentials: true })
    setNet(n => ({ ...n, socket: s }))

    const setUrlToken = (token: string) => {
      try {
        const u = new URL(window.location.href)
        u.searchParams.set('t', token)
        window.history.replaceState({}, '', u.pathname + '?' + u.searchParams.toString() + (u.hash || ''))
      } catch {}
    }

    const attemptReconnect = () => {
      const storedToken = localStorage.getItem(TOKEN_KEY) || ''
      const storedRoom = (localStorage.getItem(ROOM_KEY) || '').toUpperCase().trim()
      if (!storedRoom) return

      const clearStored = () => {
        try {
          localStorage.removeItem(ROOM_KEY)
          localStorage.removeItem(TOKEN_KEY)
        } catch {}
      }

      const trySessionReconnect = () => {
        s.emit('reconnectRoomSession', { roomCode: storedRoom }, (resp: any) => {
          if (!resp?.ok) {
            const err = (resp?.error || '').toString()
            if (err.includes('Room not found')) clearStored()
            return
          }
          if (resp?.token) {
            try { localStorage.setItem(TOKEN_KEY, resp.token) } catch {}
          }
          // state will arrive via 'state' event
        })
      }

      if (storedToken) {
        s.emit('reconnectRoom', { roomCode: storedRoom, token: storedToken }, (resp: any) => {
          if (!resp?.ok) {
            const err = (resp?.error || '').toString()
            if (err.includes('Room not found')) { clearStored(); return }
            // If this token is no longer usable (new device, cleared storage, etc) but the user is logged in,
            // session reconnect can still recover the seat.
            if (err.includes('Token belongs to another user') || err.includes('Missing token')) {
              trySessionReconnect()
            }
          }
        })
      } else {
        // No local token: try to recover via cookie session (logged-in users only).
        trySessionReconnect()
      }
    }

    s.on('connect', () => {
      setNet(n => ({ ...n, connected: true, error: null }))
      if (!pendingInviteCode) attemptReconnect()
    })
    s.on('disconnect', () => setNet(n => ({ ...n, connected: false })))

    // Also attempt reconnect once on boot (Socket.IO will queue emits until connected).
    attemptReconnect()

    s.on('state', (payload: { roomCode: string, token: string, playerIndex: number | null, isHost: boolean, occupied: boolean[], rematchReady?: boolean[], state: GameState }) => {
      setNet(n => ({
        ...n,
        roomCode: payload.roomCode,
        token: payload.token,
        playerIndex: payload.playerIndex,
        isHost: payload.isHost,
        occupied: payload.occupied,
        rematchReady: payload.rematchReady || [],
        error: null
      }))
      setState(payload.state)

      const pi = payload.playerIndex
      const phase = payload.state?.phase
      const discardDone = payload.state?.discardDone
      if (phase !== 'DISCARD') {
        setDiscardSelectedIds(new Set())
        lastDiscardHandSigRef.current = ''
      } else {
        if (lastPhaseRef.current !== 'DISCARD') {
          setDiscardSelectedIds(new Set())
        }
        if (pi != null && discardDone?.[pi]) {
          setDiscardSelectedIds(new Set())
          const hand = payload.state.hands7?.[pi] ?? []
          lastDiscardHandSigRef.current = hand.map(cardKey).sort().join('|')
        }
      }
      lastPhaseRef.current = phase ?? ''
      setDiscardSubmitting(false)

      if (typeof localStorage !== 'undefined' && localStorage.getItem('DEBUG_STATE') === '1') {
        const handLen = (payload.state?.hands7 ?? payload.state?.hands6)?.[payload.playerIndex ?? -1]?.length ?? 0
        console.log('[STATE] roomCode=%s playerIndex=%s handLen=%s phase=%s', payload.roomCode, payload.playerIndex, handLen, payload.state?.phase)
      }

      const existing = localStorage.getItem(TOKEN_KEY) || ''
      if (payload.token && (payload.playerIndex !== null || !existing)) {
        localStorage.setItem(TOKEN_KEY, payload.token)
        setUrlToken(payload.token)
      }
      if (payload.roomCode) localStorage.setItem(ROOM_KEY, payload.roomCode)
    })

    s.on('room:state', (payload: RoomStateSnapshot) => {
      setNet(n => ({ ...n, roomState: payload }))
    })

    s.on('roomEnded', (payload: { message?: string }) => {
      // Room was ended by host (or removed). Return to home.
      try {
        localStorage.removeItem(ROOM_KEY)
        localStorage.removeItem(TOKEN_KEY)
      } catch {}
      setState(null)
      setNet(n => ({ ...n, roomCode: '', token: '', playerIndex: null, isHost: false, occupied: [], roomState: null, error: payload?.message ?? 'Room ended' }))
    })

    s.on('kicked', () => {
      try {
        localStorage.removeItem(ROOM_KEY)
        localStorage.removeItem(TOKEN_KEY)
      } catch {}
      setState(null)
      setNet(n => ({ ...n, roomCode: '', token: '', playerIndex: null, isHost: false, occupied: [], roomState: null, error: null, kickedMessage: 'You were removed from the game' }))
    })

    return () => { s.disconnect() }
  }, [])

  useEffect(() => {
    if (!isAuthed) return
    const code = pendingInviteCode || (typeof localStorage !== 'undefined' ? (localStorage.getItem(PENDING_JOIN_ROOM) || '').trim().toUpperCase() : '') || null
    if (!code || !net.socket?.connected) return
    if (autoJoinStartedRef.current) return
    autoJoinStartedRef.current = true
    setAutoJoinStatus('joining')
    const s = net.socket
    void attemptAutoJoin(code, s)
  }, [isAuthed, pendingInviteCode, net.connected, net.socket])

  const currentHigh = useMemo(() => state ? currentHighBid(state.bidHistory) : null, [state?.bidHistory])
  const me = (state && net.playerIndex !== null) ? state.players[net.playerIndex] : null
  const dealer = state ? state.players[state.dealerIndex] : null
  const current = state ? state.players[state.currentPlayerIndex] : null
  const bidder = state ? state.players[state.currentBidderIndex] : null

  /** Display name for a seat; prefers room:state snapshot so reconnects don't miss names. */
  function playerName(seatIndex: number): string {
    const rs = net.roomState
    if (rs?.players) {
      const p = rs.players.find(x => x.seatIndex === seatIndex)
      if (p?.username) return p.username
    }
    const p = state?.players[seatIndex]
    return p?.name ?? (seatIndex === 0 ? 'Host' : `Player ${seatIndex + 1}`)
  }

  const roomReady = !!(net.roomCode && state)

  const effectivePendingCode = useMemo(() => {
    try {
      const fromStorage = typeof localStorage !== 'undefined' ? localStorage.getItem(PENDING_JOIN_ROOM) : null
      const s = (fromStorage || '').trim().toUpperCase()
      if (s) return s
    } catch {}
    return pendingInviteCode || null
  }, [pendingInviteCode])

  useEffect(() => {
    if (roomReady) return
    setChatMessages([])
    setChatError(null)
    setChatLoading(false)
    chatLoadedForRoomRef.current = null
  }, [roomReady])

  useEffect(() => {
    if (!roomReady || !net.roomCode || !net.socket?.connected) return
    if (chatLoadedForRoomRef.current === net.roomCode) return
    const roomCode = net.roomCode
    setChatLoading(true)
    setChatError(null)
    net.socket.emit('chat:history', { roomCode }, (resp: any) => {
      if (resp?.ok === true && Array.isArray(resp.messages)) {
        setChatMessages((resp.messages as ChatMessage[]).slice(-50))
        chatLoadedForRoomRef.current = roomCode
      } else {
        setChatError(resp?.error ?? 'Failed to load chat')
      }
      setChatLoading(false)
    })
  }, [roomReady, net.roomCode, net.socket?.connected])

  useEffect(() => {
    const socket = net.socket
    if (!socket) return
    const handler = (payload: { roomCode?: string; message?: ChatMessage }) => {
      if (payload.roomCode !== net.roomCode) return
      if (!payload.message) return
      setChatMessages(prev => [...prev, payload.message!].slice(-50))
    }
    socket.on('chat:message', handler)
    return () => { socket.off('chat:message', handler) }
  }, [net.socket, net.roomCode])

  const onSendChat = useCallback((text: string) => {
    if (!net.socket?.connected || !net.roomCode) {
      setChatError('Not connected')
      return
    }
    setChatError(null)
    net.socket.emit('chat:send', { roomCode: net.roomCode, text }, (resp: any) => {
      if (resp?.ok !== true) {
        setChatError(resp?.error ?? 'Send failed')
      }
    })
  }, [net.socket, net.roomCode])

  const nameTrim = (myName || '').trim()
  const nameValid = nameTrim.length >= 1 && nameTrim.length <= 18
  const normalizedJoinCode = (joinCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const joinCodeValid = normalizedJoinCode.length >= 4 && normalizedJoinCode.length <= 8

  function fetchLeaderboard() {
    try {
      if (!net.socket || !net.socket.connected) {
        setLeaderboardError('Not connected')
        setLeaderboardRows([])
        return
      }
      setLeaderboardLoading(true)
      setLeaderboardError(null)
      net.socket.emit('leaderboard:get', { limit: 10 }, (resp: any) => {
        try {
          if (resp && resp.ok === true && Array.isArray(resp.rows)) {
            setLeaderboardRows(resp.rows)
            setLeaderboardError(null)
          } else {
            setLeaderboardRows([])
            setLeaderboardError(resp?.error ?? 'Failed to load leaderboard')
          }
        } finally {
          setLeaderboardLoading(false)
        }
      })
    } catch {
      setLeaderboardError('Failed to load leaderboard')
      setLeaderboardRows([])
      setLeaderboardLoading(false)
    }
  }

  useEffect(() => {
    if (roomReady || !authUser) leaderboardFetchedRef.current = false
  }, [roomReady, authUser])

  useEffect(() => {
    if (!authUser || roomReady || !net.socket?.connected) return
    if (leaderboardFetchedRef.current) return
    leaderboardFetchedRef.current = true
    fetchLeaderboard()
  }, [authUser, roomReady, net.socket?.connected])

  function showToast(msg: string) {
    setHomeToast(msg)
    window.setTimeout(() => setHomeToast(null), 1500)
  }

  async function copyToClipboard(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      showToast('Copied')
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = value
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        showToast('Copied')
      } catch {
        showToast('Copy failed')
      }
    }
  }

  function rpc(event: string, payload: any, onOk?: (resp: any) => void, onErr?: (msg: string) => void) {
    if (!net.socket) return
    net.socket.emit(event, payload, (resp: any) => {
      if (!resp?.ok) {
        const msg = resp?.error ?? 'Request failed'
        console.error('[RPC]', event, 'failed:', msg)
        setNet(n => ({ ...n, error: msg }))
        showToast(msg)
        onErr?.(msg)
        return
      }
      setNet(n => ({ ...n, error: null }))
      onOk?.(resp)
    })
  }

  function send(action: Action) {
    if (!net.roomCode || !net.token) return
    rpc('action', { roomCode: net.roomCode, token: net.token, action })
  }
  function createRoom() {
    // createRoom always uses the primary socket connection.
    // (joinByInvite has an optional socket override, but create does not.)
    if (!net.connected || homeBusy) return
    if (!nameValid) {
      setNet(n => ({ ...n, error: 'Please enter a name (1 to 18 characters).' }))
      return
    }
    setHomeBusy('create')
    // Use the settings controlled by the Create Room form.
    const desiredPlayers = Number(settings.playerCount) || 2
    const target = Number(settings.targetScore) || 11
    rpc(
      'createRoom',
      { settings: { playerCount: desiredPlayers as any, targetScore: target as any }, name: nameTrim || 'Host' },
      (resp) => {
        setJoinCode(resp.roomCode)
        try {
          localStorage.setItem(ROOM_KEY, resp.roomCode)
          localStorage.setItem(TOKEN_KEY, resp.token)
        } catch {}
        setNet(n => ({ ...n, roomCode: resp.roomCode, token: resp.token, playerIndex: resp.playerIndex ?? n.playerIndex, isHost: true, kickedMessage: undefined }))
        // Ask server to push current state
        net.socket?.emit('reconnectRoom', { roomCode: resp.roomCode, token: resp.token }, () => {})
        setHomeBusy(null)
      },
      () => setHomeBusy(null)
    )
  }

  function joinRoom() {
    if (!net.connected || homeBusy) return
    if (!nameValid) {
      setNet(n => ({ ...n, error: 'Please enter a name (1 to 18 characters).' }))
      return
    }
    const code = normalizedJoinCode
    if (!joinCodeValid) {
      setNet(n => ({ ...n, error: 'Please enter a valid room code.' }))
      return
    }
    setHomeBusy('join')
    const storedRoom = localStorage.getItem(ROOM_KEY) || ''
    const storedToken = localStorage.getItem(TOKEN_KEY) || ''
    const payload: { roomCode: string; name: string; spectate?: boolean; token?: string } = {
      roomCode: code,
      name: (authUser?.username || myName || 'Player').trim() || 'Player',
      spectate: watchOnly,
    }
    if (storedRoom === code && storedToken) payload.token = storedToken
    rpc(
      'joinRoom',
      payload,
      (resp) => {
        try {
          localStorage.setItem(ROOM_KEY, resp.roomCode)
          localStorage.setItem(TOKEN_KEY, resp.token)
        } catch {}
        setNet(n => ({ ...n, roomCode: resp.roomCode, token: resp.token, playerIndex: resp.playerIndex ?? n.playerIndex, kickedMessage: undefined, error: resp.error ?? null }))
        setHomeBusy(null)
      },
      () => setHomeBusy(null)
    )
  }

  function joinByInvite(inviteCode: string, socketOverride?: Socket): Promise<{ ok: boolean; error?: string }> {
    const s = socketOverride || net.socket
    if (!s) return Promise.resolve({ ok: false, error: 'No socket' })
    const connected = socketOverride ? socketOverride.connected : net.connected
    if (!connected || homeBusy) return Promise.resolve({ ok: false, error: 'Not connected or busy' })
    if (!nameValid) {
      setNet(n => ({ ...n, error: 'Please enter a name (1 to 18 characters).' }))
      return Promise.resolve({ ok: false, error: 'Please enter a name (1 to 18 characters).' })
    }
    const code = (inviteCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim()
    if (!code) {
      setNet(n => ({ ...n, error: 'Invalid invite link.' }))
      return Promise.resolve({ ok: false, error: 'Invalid invite link.' })
    }
    const name = (authUser?.username || myName || 'Player').trim() || 'Player'
    const storedRoom = localStorage.getItem(ROOM_KEY) || ''
    const existingToken = localStorage.getItem(TOKEN_KEY) || ''

    const onJoinSuccess = (resp: any) => {
      try {
        localStorage.setItem(ROOM_KEY, resp.roomCode)
        localStorage.setItem(TOKEN_KEY, resp.token)
        localStorage.removeItem(PENDING_JOIN_ROOM)
      } catch {}
      try {
        const u = new URL(window.location.href)
        u.searchParams.set('t', resp.token)
        window.history.replaceState({}, '', u.pathname + '?' + u.searchParams.toString() + (u.hash || ''))
      } catch {}
      setNet(n => ({ ...n, roomCode: resp.roomCode, token: resp.token, playerIndex: resp.playerIndex ?? n.playerIndex, isHost: !!resp.isHost, kickedMessage: undefined, error: resp.error ?? null }))
      setPendingInviteCode(null)
      try {
        if (window.location.pathname.startsWith('/join/')) {
          window.history.replaceState({}, '', '/')
        } else {
          const u = new URL(window.location.href)
          if (u.searchParams.has('join')) {
            u.searchParams.delete('join')
            if (u.searchParams.has('spectate')) u.searchParams.delete('spectate')
            window.history.replaceState({}, '', u.pathname + u.search + u.hash)
          }
        }
      } catch {}
      setHomeBusy(null)
    }

    setHomeBusy('join')

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const resolveWithError = (err: string) => {
        setNet(n => ({ ...n, error: err }))
        setHomeBusy(null)
        resolve({ ok: false, error: err })
      }
      try {
        if (code.length === 5) {
          const joinPayload: { roomCode: string; name: string; spectate?: boolean; token?: string } = {
            roomCode: code,
            name: name.trim() || 'Player',
            spectate: watchOnly,
          }
          if (storedRoom === code && existingToken) joinPayload.token = existingToken
          s.emit('joinRoom', joinPayload, (resp: any) => {
            try {
              if (!resp?.ok) {
                const msg = resp?.error ?? 'Join failed'
                resolveWithError(msg)
                return
              }
              onJoinSuccess(resp)
              resolve({ ok: true })
            } catch (e) {
              resolveWithError('Network error joining room')
            }
          })
          return
        }
        s.emit('joinInvite', { inviteCode: code, name, spectate: watchOnly }, (resp: any) => {
          try {
            if (!resp?.ok) {
              const msg = resp?.error ?? 'Invite not found or expired. Ask the host for the room code (e.g. /join/ABCDE).'
              resolveWithError(msg)
              return
            }
            onJoinSuccess(resp)
            resolve({ ok: true })
          } catch (e) {
            resolveWithError('Network error joining room')
          }
        })
      } catch (e) {
        resolveWithError('Network error joining room')
      }
    })
  }

  async function attemptAutoJoin(code: string, s: Socket) {
    setAutoJoinStatus('joining')
    setAutoJoinError('')
    if (typeof localStorage !== 'undefined' && localStorage.getItem('DEBUG_JOIN') === '1') {
      console.log('[DEBUG_JOIN] parsed code=', code, 'join attempt started')
    }
    const delays = [300, 600, 1200, 2000, 3000]
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const result = await joinByInvite(code, s)
      if (typeof localStorage !== 'undefined' && localStorage.getItem('DEBUG_JOIN') === '1') {
        console.log('[DEBUG_JOIN] result.ok=', result.ok, 'error=', result.error)
      }
      if (result.ok) {
        setAutoJoinStatus('success')
        setAutoJoinError('')
        try {
          localStorage.removeItem(PENDING_JOIN_ROOM)
        } catch {}
        setPendingInviteCode(null)
        window.history.replaceState({}, '', '/')
        return
      }
      const err = result.error ?? 'Join failed'
      const isRoomNotFound = /room not found/i.test(err)
      if (isRoomNotFound || attempt >= delays.length) {
        setAutoJoinStatus('failed')
        setAutoJoinError(err)
        setNet(n => ({ ...n, error: err }))
        if (isRoomNotFound && code) {
          setJoinCode(code)
          setTimeout(() => {
            joinCodeInputRef.current?.focus()
            joinCodeInputRef.current?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          }, 100)
        }
        return
      }
      await new Promise(r => setTimeout(r, delays[attempt]))
    }
  }

  function takeSeat(seat: number) {
    if (!net.roomCode || !net.token) return
    rpc('takeSeat', { roomCode: net.roomCode, token: net.token, seat, name: (authUser?.username || myName).trim() || myName })
  }

  function leaveSeat() {
    if (!net.roomCode || !net.token) return
    rpc('leaveSeat', { roomCode: net.roomCode, token: net.token })
  }

  function hostKick(seat: number) {
    if (!net.roomCode || !net.token) return
    rpc('hostKick', { roomCode: net.roomCode, token: net.token, seat }, (resp: { ok?: boolean; error?: string }) => {
      if (resp?.ok === false) setNet(n => ({ ...n, error: resp?.error ?? 'Kick failed' }))
    })
  }

  function hostReset() {
    if (!net.roomCode || !net.token) return
    rpc('hostReset', { roomCode: net.roomCode, token: net.token }, (resp) => {
      if (!resp?.ok) {
        const msg = (resp?.error || 'Rematch failed').toString()
        setNet(n => ({ ...n, error: msg }))
        return
      }
      setNet(n => ({ ...n, error: null }))
    })
  }

  function toggleRematchReady() {
    if (!net.roomCode || !net.token) return
    const seat = net.playerIndex
    if (seat === null || seat === undefined) return
    const currentlyReady = !!net.rematchReady?.[seat]
    rpc('rematchReady', { roomCode: net.roomCode, token: net.token, ready: !currentlyReady }, (resp) => {
      if (resp && resp.ok === false) {
        const msg = (resp?.error || 'Rematch ready failed').toString()
        setNetError({ msg })
      }
    })
  }


  function hostInvite() {
    if (!net.roomCode || !net.token) return
    const link = `${window.location.origin}/join/${net.roomCode}`
    setInviteLink(link)
    void copyToClipboard(link)
  }


  function hostEndRoom() {
    if (!net.roomCode || !net.token) return
    const ok = window.confirm('End this room for everyone and return to Home?')
    if (!ok) return
    rpc('hostEndRoom', { roomCode: net.roomCode, token: net.token }, () => {
      // server will emit roomEnded to all clients
    })
  }

  function clearRoomAndGoToLobby() {
    try {
      localStorage.removeItem(ROOM_KEY)
      localStorage.removeItem(TOKEN_KEY)
    } catch {}
    setState(null)
    setNet(n => ({
      ...n,
      roomCode: '',
      token: '',
      playerIndex: null,
      isHost: false,
      occupied: [],
      rematchReady: [],
      roomState: null,
      error: null,
      kickedMessage: undefined,
    }))
  }

  function leaveRoomToLobby() {
    if (!net.roomCode) return
    if (!window.confirm('Leave this table and return to the lobby?')) return
    if (!net.connected || !net.socket) {
      clearRoomAndGoToLobby()
      return
    }
    net.socket.emit('leaveRoom', { roomCode: net.roomCode }, (resp: any) => {
      if (resp?.ok) {
        clearRoomAndGoToLobby()
      } else {
        showToast(resp?.error ?? 'Could not leave room')
      }
    })
  }

  function hostUpdateSettings(next: GameSettings) {
    if (!net.roomCode || !net.token) return
    rpc('hostUpdateSettings', { roomCode: net.roomCode, token: net.token, settings: next })
  }

  function placeBid(b: BidKind) {
    if (!state) return
    if (b === 'STM') {
      const ok = window.confirm('Are you sure? Shoot The Moon means win every trick AND capture High, Low, Jack, and Game. Continue?')
      if (!ok) return
    }
    send({ type: 'PLACE_BID', bid: b, suit: b === 'PASS' ? undefined : bidSuit })
  }

  function takeOut() {
    if (!state) return
    send({ type: 'TAKE_OUT' })
  }


  const bidButtons: { b: BidKind, primary?: boolean }[] = [
    { b: 2, primary: true },
    { b: 3, primary: true },
    { b: 4, primary: true },
    { b: 'STM', primary: true },
    { b: 'PASS' },
  ]

  const canBid = (b: BidKind): boolean => {
    if (!state) return false
    if (state.phase !== 'BIDDING') return false
    if (b === 'PASS') return true
    if (!currentHigh) return true
    return strength(b as Exclude<BidKind,'PASS'>) > strength(currentHigh)
  }

  const canTakeOut = (() => {
    if (!state) return false
    if (state.phase !== 'BIDDING') return false
    if (currentHigh) return false
    const pc = state.players.length
    const cur = state.currentBidderIndex
    // Robust: allow Take the Out whenever it is the current bidder's turn,
    // nobody has made a non-pass bid, and all other players' most recent bids are PASS.
    const lastByPlayer = new Map<number, BidKind>()
    for (const h of state.bidHistory) lastByPlayer.set(h.playerIndex, h.bid)
    // Current bidder must not have already bid in this bidding cycle
    if (lastByPlayer.has(cur)) return false
    for (let pi = 0; pi < pc; pi++) {
      if (pi === cur) continue
      if (lastByPlayer.get(pi) !== 'PASS') return false
    }
    return true
  })()



  const winnerTeam = (state && state.winnerTeamId) ? state.teams.find(t => t.id === state.winnerTeamId) : null

  const isMyTurn = !!state && state.phase === 'PLAY' && net.playerIndex !== null && net.playerIndex !== undefined && state.currentPlayerIndex === net.playerIndex

  const [confettiSeed, setConfettiSeed] = useState<number>(1)
  const [confettiOn, setConfettiOn] = useState<boolean>(false)
  const lastUiPhaseRef = useRef<string | null>(null)
  useEffect(() => {
    const phase = state?.phase ?? null
    const prev = lastUiPhaseRef.current
    lastUiPhaseRef.current = phase
    if (phase === 'GAME_END' && prev !== 'GAME_END') {
      setConfettiSeed(Date.now())
      setConfettiOn(true)
      const t = window.setTimeout(() => setConfettiOn(false), 2600)
      return () => window.clearTimeout(t)
    }
    return
  }, [state?.phase])

  const teamDisplayName = (teamId: string): string => {
    if (!state) return ''
    const names = state.players
      .filter(p => p.teamId === teamId)
      .map(p => (p.name ?? '').trim())
      .filter(Boolean)
    return names.length ? names.join(' & ') : (state.teams.find(t => t.id === teamId)?.name ?? 'Team')
  }

const lastHistLen = useRef(0)
  const scoreDelayUntilRef = useRef<number>(0)
  const scoreAnimTimerRef = useRef<number | null>(null)
  const lastScoreKeyRef = useRef<string>('')


useEffect(() => {
  if (!state) return
  const plays = state.currentTrick?.plays ?? []
  // If the trick is fully populated but not yet resolved, do nothing.
  if (plays.length === state.players.length && state.phase === 'PLAY') return

  // When a trick completes, currentTrick resets and history grows. Show last trick briefly with pacing.
  if (state.trickHistory && state.trickHistory.length) {
    const last = state.trickHistory[state.trickHistory.length - 1]
    setLingerTrickPlays(last.plays)
    setLingerWinnerIndex(last.winnerIndex)
    setLingerLeaderIndex(last.leaderIndex)
    setLingerAnim('hold')

    // Total linger time. We switch to a subtle "capture" slide part way through.
    const totalMs = 1200
    const slideAtMs = 700
    const nowMs = Date.now()
    setLingerUntil(nowMs + totalMs)
    // Sync HUD score animations to happen right after the trick is "captured"
    scoreDelayUntilRef.current = nowMs + totalMs

    const slideTimer = window.setTimeout(() => setLingerAnim('slide'), slideAtMs)
    const resetTimer = window.setTimeout(() => setLingerAnim('hold'), totalMs + 50)

    return () => {
      window.clearTimeout(slideTimer)
      window.clearTimeout(resetTimer)
    }
  }
}, [state?.trickHistory?.length])


useEffect(() => {
  if (!state) return

  // Initialize maps on first load
  setHudScoresAnim(prev => {
    if (Object.keys(prev).length) return prev
    const init: Record<string, number> = {}
    state.teams.forEach(t => { init[t.id] = t.score })
    return init
  })
  setHudSetsAnim(prev => {
    if (Object.keys(prev).length) return prev
    const init: Record<string, number> = {}
    state.teams.forEach(t => { init[t.id] = t.sets })
    return init
  })
}, [state?.teams?.length])

useEffect(() => {
  if (!state) return

  // Animate score and sets changes
  const durationMs = 420
  const scoreKey = state.teams.map(t => `${t.id}:${t.score}:${t.sets}`).join('|')

  const animate = (fromVal: number, toVal: number, onUpdate: (v: number) => void) => {
    if (fromVal === toVal) return
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      const v = Math.round(fromVal + (toVal - fromVal) * t)
      onUpdate(v)
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  const run = () => {
    lastScoreKeyRef.current = scoreKey
    if (scoreAnimTimerRef.current != null) {
      window.clearTimeout(scoreAnimTimerRef.current)
      scoreAnimTimerRef.current = null
    }

    setHudScoresAnim(prev => {
      const next = { ...prev }
      state.teams.forEach(team => {
        const from = prev[team.id] ?? team.score
        const to = team.score
        if (from !== to) {
          setFlashTeamScore(f => ({ ...f, [team.id]: true }))
          window.setTimeout(() => setFlashTeamScore(f => ({ ...f, [team.id]: false })), 600)
          animate(from, to, (v) => setHudScoresAnim(p => ({ ...p, [team.id]: v })))
          next[team.id] = from
        } else {
          next[team.id] = from
        }
      })
      return next
    })

    setHudSetsAnim(prev => {
      const next = { ...prev }
      state.teams.forEach(team => {
        const from = prev[team.id] ?? team.sets
        const to = team.sets
        if (from !== to) {
          setFlashTeamSets(f => ({ ...f, [team.id]: true }))
          window.setTimeout(() => setFlashTeamSets(f => ({ ...f, [team.id]: false })), 700)
          animate(from, to, (v) => setHudSetsAnim(p => ({ ...p, [team.id]: v })))
          next[team.id] = from
        } else {
          next[team.id] = from
        }
      })
      return next
    })
  }

  const now = Date.now()
  const delayUntil = scoreDelayUntilRef.current

  // If a trick just resolved, sync the HUD updates to the end of the capture slide.
  if (now < delayUntil) {
    if (lastScoreKeyRef.current === scoreKey && scoreAnimTimerRef.current != null) return
    if (scoreAnimTimerRef.current != null) window.clearTimeout(scoreAnimTimerRef.current)
    scoreAnimTimerRef.current = window.setTimeout(run, Math.max(0, delayUntil - now + 40))
    return () => {
      if (scoreAnimTimerRef.current != null) {
        window.clearTimeout(scoreAnimTimerRef.current)
        scoreAnimTimerRef.current = null
      }
    }
  }

  run()
  return undefined
}, [state?.teams?.map(t => `${t.id}:${t.score}:${t.sets}`).join('|')])

useEffect(() => {
  if (!state) return
  const prev = prevTrumpRef.current
  const next = state.trump ?? null
  if (next && next !== prev) {
    setFlashTrump(true)
    setTrumpRippleTick(t => t + 1)
    window.setTimeout(() => setFlashTrump(false), 650)
  }
  prevTrumpRef.current = next
}, [state?.trump])






  return (
    <div className="container">
      <div className="header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
  <h1>Cuse Pitch</h1>
  <div style={{ display: 'flex', gap: 8 }}>
    <button
      className="btn"
      onClick={() => { sfx.unlock(); sfx.setEnabled(!sfx.enabled) }}
      aria-label="Toggle sound"
      style={{ padding: '8px 10px', fontWeight: 800 }}
    >
      {sfx.enabled ? 'Sound: On' : 'Sound: Off'}
    </button>
  </div>
</div>
        <div className="small" style={{ color: 'rgba(255,255,255,0.92)' }}>
          Cuse rules multiplayer pitch.
        </div>
        <div className="small" style={{ color: 'rgba(255,255,255,0.92)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span>
            Socket: <strong>{net.connected ? 'Connected' : 'Reconnecting…'}</strong>
            {roomReady ? <> | Room: <strong>{net.roomCode}</strong> | You: <strong>{net.playerIndex !== null ? playerName(net.playerIndex) : 'Spectator'}</strong></> : null}
            {net.isHost ? <> | <strong>Host</strong></> : null}
          </span>
          {roomReady && !net.isHost ? (
            <button type="button" className="btn small" onClick={leaveRoomToLobby}>
              Return to Lobby
            </button>
          ) : null}
        </div>
        {roomReady && net.playerIndex === null ? (
          <div className="small" style={{ marginTop: 6, padding: '8px 10px', background: 'rgba(255,255,255,0.1)', borderRadius: 8 }}>
            <strong>Spectating</strong> — Take a seat to play.
          </div>
        ) : null}
        {net.error ? (
          <div className="small" style={{ color: '#ffd1d1', marginTop: 6 }}>
            Error: {net.error}
          </div>
        ) : null}
      </div>

      {!roomReady ? (
        <div className="row" style={{ marginTop: 12 }}>
          {net.kickedMessage ? (
            <div className="errorBox" style={{ marginBottom: 12 }}>
              {net.kickedMessage}
              <button type="button" className="btn small" style={{ marginLeft: 8 }} onClick={() => setNet(n => ({ ...n, kickedMessage: undefined }))}>Dismiss</button>
            </div>
          ) : null}
          {net.error ? (<div className="errorBox" style={{ marginBottom: 12 }}>{net.error}</div>) : null}
          {effectivePendingCode && autoJoinStatus === 'joining' ? (
            <div className="banner" style={{ marginBottom: 12 }}>
              Joining room {effectivePendingCode}…
            </div>
          ) : null}
          {effectivePendingCode && autoJoinStatus === 'failed' ? (
            <div className="errorBox" style={{ marginBottom: 12 }}>
              Could not join room {effectivePendingCode}: {autoJoinError || net.error || 'Unknown error'}. The room may have ended. Ask the host to create a new room and send a new link.
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    setJoinCode(effectivePendingCode ?? '')
                    joinCodeInputRef.current?.focus()
                  }}
                >
                  Enter code manually
                </button>
              </div>
            </div>
          ) : null}
          {!isAuthed && effectivePendingCode ? (
            <div className="banner" style={{ marginBottom: 12 }}>
              Log in to join room {effectivePendingCode}.
            </div>
          ) : null}

          <div className="bannerRow" style={{ marginBottom: 12 }}>
            <div className="banner" style={{ alignItems: 'stretch' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 900 }}>Account</div>
                  <div className="small">
                    {authUser ? `Logged in as ${authUser.username}` : 'Login is required to create or join a game.'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {authUser ? (
                    <>
                      <button className="btn" onClick={openProfile} disabled={authBusy}>Profile</button>
                      <button className="btn" onClick={doLogout} disabled={authBusy}>Logout</button>
                    </>
                  ) : (
                    <>
                      <button className="btn" onClick={() => { setAuthMode('login'); setAuthError(null) }} disabled={authBusy}>Login</button>
                      <button className="btn" onClick={() => { setAuthMode('signup'); setAuthError(null) }} disabled={authBusy}>Sign up</button>
                    </>
                  )}
                </div>
              </div>

              {!authUser && authMode ? (
                <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  {authMode === 'resetRequest' ? (
                    <>
                      <div style={{ minWidth: 260 }}>
                        <label style={{ display: 'block' }}>Email</label>
                        <input value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="you@example.com" />
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button className="primary" onClick={() => void doResetRequest()} disabled={authBusy}>Send reset link</button>
                        <button className="btn" onClick={() => { setAuthMode('login'); setAuthError(null) }} disabled={authBusy}>Back</button>
                      </div>
                      {authError ? <div className="fieldHint" style={{ width: '100%' }}>{authError}</div> : null}
                    </>
                  ) : authMode === 'resetConfirm' ? (
                    <>
                      <div style={{ minWidth: 260 }}>
                        <label style={{ display: 'block' }}>Reset token</label>
                        <input value={resetToken} onChange={e => setResetToken(e.target.value)} placeholder="paste token" />
                      </div>
                      <div style={{ minWidth: 220 }}>
                        <label style={{ display: 'block' }}>New password</label>
                        <input type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="new password" />
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button className="primary" onClick={() => void doResetConfirm()} disabled={authBusy}>Update password</button>
                        <button className="btn" onClick={() => { setAuthMode('login'); setAuthError(null); setAuthPassword(''); setResetToken('') }} disabled={authBusy}>Cancel</button>
                      </div>
                      {authError ? <div className="fieldHint" style={{ width: '100%' }}>{authError}</div> : null}
                    </>
                  ) : (
                    <>
                      <div style={{ minWidth: 180 }}>
                        <label style={{ display: 'block' }}>{authMode === 'login' ? 'Username or email' : 'Username'}</label>
                        <input value={authUsername} onChange={e => setAuthUsername(e.target.value)} placeholder={authMode === 'login' ? 'Username or email' : 'username'} />
                      </div>
                      {authMode === 'signup' ? (
                        <div style={{ minWidth: 260 }}>
                          <label style={{ display: 'block' }}>Email</label>
                          <input value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="you@example.com" />
                        </div>
                      ) : null}
                      <div style={{ minWidth: 220 }}>
                        <label style={{ display: 'block' }}>Password</label>
                        <input type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="password" onKeyDown={e => { if (e.key === 'Enter' && !authBusy) void doAuthSubmit() }} />
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button className="primary" onClick={() => void doAuthSubmit()} disabled={authBusy}>
                          {authBusy ? 'Working…' : (authMode === 'login' ? 'Login' : 'Create account')}
                        </button>
                        <button className="btn" onClick={() => { setAuthMode(null); setAuthError(null); setAuthPassword('') }} disabled={authBusy}>Cancel</button>
                        {authMode === 'login' ? (
                          <button className="btn" onClick={() => { setAuthMode('resetRequest'); setAuthError(null) }} disabled={authBusy}>Forgot password</button>
                        ) : null}
                      </div>
                      {authError ? <div className="fieldHint error" style={{ width: '100%' }}>{authError}</div> : null}
                      {!authError ? <div className="fieldHint" style={{ width: '100%' }}>Usernames: 3 to 18 chars, letters, numbers, underscore. Password: 8+ chars.</div> : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          {authUser && net.roomCode ? (
            <div className="bannerRow" style={{ marginBottom: 12 }}>
              <div className="banner">
                <div style={{ fontWeight: 900 }}>Current room</div>
                <div className="bannerCode">{net.roomCode}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn" onClick={() => copyToClipboard(net.roomCode)}>Copy</button>
                  {homeToast ? <span className="toastPill">{homeToast}</span> : null}
                </div>
              </div>
            </div>
          ) : null}

          {authUser ? (
            <>
              <div className="col">
                <div className="card">
                  <h2>Join a room</h2>
                  <label>Your name</label>
                  <input value={myName} readOnly={true} />
                  <div className="fieldHint">Using your account username.</div>

                  <div style={{ height: 10 }} />

                  <label>Room code</label>
                  <input
                    ref={joinCodeInputRef}
                    value={joinCode}
                    onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                    onKeyDown={e => { if (e.key === 'Enter' && net.connected && !homeBusy && joinCodeValid) joinRoom() }}
                    placeholder="ABCDE"
                    onBlur={() => { if (joinCode !== normalizedJoinCode) setJoinCode(normalizedJoinCode) }}
                  />

                  <div style={{ marginTop: 10 }}>
                    <label className="pill" style={{ cursor: 'pointer' }}>
                      <input type="checkbox" checked={watchOnly} onChange={e => setWatchOnly(e.target.checked)} style={{ marginRight: 8 }} />
                      Watch only (spectator)
                    </label>
                    <div className="fieldHint">Spectators can watch immediately and take a seat later if one opens.</div>
                  </div>

                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="primary" onClick={joinRoom} disabled={!net.connected || homeBusy !== null || !joinCodeValid}>
                      {homeBusy === 'join' ? 'Joining…' : 'Join Room'}
                    </button>
                  </div>

                  <p className="small" style={{ marginTop: 10 }}>
                    If you refresh, you should reclaim your seat automatically.
                  </p>
                </div>
              </div>

              <div className="col">
                <div className="card">
                  <h2>Create a room</h2>

                  <label>Your name</label>
                  <input value={myName} readOnly={true} />
                  <div className="fieldHint">Using your account username.</div>

                  <div style={{ height: 10 }} />

                  <div className="row">
                    <div className="col">
                      <label>Players</label>
                      <select value={settings.playerCount} onChange={e => setSettings(s => ({ ...s, playerCount: Number(e.target.value) as any }))}>
                        <option value={2}>2 players</option>
                        <option value={3}>3 players</option>
                        <option value={4}>4 players (2v2)</option>
                        <option value={6}>6 players (2v2v2)</option>
                      </select>
                    </div>

                    <div className="col">
                      <label>Play to</label>
                      <select value={settings.targetScore} onChange={e => setSettings(s => ({ ...s, targetScore: Number(e.target.value) as any }))}>
                        <option value={11}>11</option>
                        <option value={21}>21</option>
                      </select>
                    </div>
                  </div>

                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="primary" onClick={createRoom} disabled={!net.connected || homeBusy !== null}>
                      {homeBusy === 'create' ? 'Creating…' : 'Create Room'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="col">
                <LeaderboardPanel
                  rows={leaderboardRows.map(r => ({ name: r.name, games: r.games, wins: r.wins, losses: r.losses, winPct: r.winPct }))}
                  loading={leaderboardLoading}
                  error={leaderboardError}
                  onRefresh={fetchLeaderboard}
                />
              </div>
            </>
          ) : (
            <div className="col">
              <div className="card">
                <h2>Login required</h2>
                <div className="small">Please log in or create an account above to create or join a game.</div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {roomReady && state ? (
        <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: isNarrow ? '1fr' : 'minmax(0, 1fr) 340px',
            gap: 12,
            alignItems: 'start',
            marginTop: 12,
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="card" style={{ margin: 0 }}>
              <h2>Table</h2>
          <div className="hudBar">
            <div className="hudLeft">
              <div><strong>Phase:</strong> {state.phase}</div>
              <div><strong>Dealer:</strong> {playerName(state.dealerIndex) ?? '—'}</div>
              <div className={`trumpWrap ${flashTrump ? 'trumpFlash' : ''}`}><strong>Trump:</strong> <span key={trumpRippleTick} className={`trumpIcon ${flashTrump ? 'trumpRipple' : ''}`}>{state.trump ? suitSymbol[state.trump] : '—'}</span></div>
              <div><strong>Target:</strong> {state.settings.targetScore}</div>
              <div><strong>You:</strong> {net.playerIndex != null ? playerName(net.playerIndex) : '—'} {net.playerIndex != null ? `(Seat ${net.playerIndex + 1})` : ''}</div>
              <div><strong>Turn:</strong> {playerName(state.currentPlayerIndex) ?? '—'}</div>
            </div>

            <div className="hudScores">
              {state.teams.map(t => (
                <div key={t.id} className="hudTeam">
                  <div className="hudTeamName">{teamDisplayName(t.id)}</div>
                  <div className="hudTeamMeta">
                    <span className={`hudScore ${flashTeamScore[t.id] ? 'hudFlash' : ''}`}>Score: {hudScoresAnim[t.id] ?? t.score}</span>
                    <span className={`hudSets ${flashTeamSets[t.id] ? 'hudFlash' : ''}`}>Sets: {hudSetsAnim[t.id] ?? t.sets}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="hudRight">
              <button className="btn" onClick={() => setShowPlayers(true)}>Players</button>
              {net.isHost && (
                <>
                  <button className="btn" onClick={hostInvite}>Invite</button>
                  <button className="btn" onClick={hostReset}>Reset</button>
                  <button className="btn danger" onClick={hostEndRoom}>End Room</button>
                </>
              )}
            </div>
          </div>



              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                <label className="pill" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={sfx.enabled} onChange={e => { sfx.unlock(); sfx.setEnabled(e.target.checked) }} style={{ marginRight: 8 }} />
                  Sound
                </label>

                <button className="primary" onClick={() => setShowHistory(v => !v)}>
                  {showHistory ? 'Hide' : 'Show'} Trick History
                </button>
              </div>

              

              


      <div className="metaRow">
        <div className="metaPills">
          <span className="metaPill">Players: {state.settings.playerCount}</span>
          <span className="metaPill">Play to: {state.settings.targetScore}</span>
          {state.trump ? <span className="metaPill">Trump: <span className={isRedSuit(state.trump) ? 'redSuit' : ''}>{suitSymbol[state.trump]}</span> {state.trump}</span> : null}
        </div>

        <div className="metaPlayers">
          {state.players.map((p, idx) => {
            if (!p.connected) return null
            const isTurn = idx === state.currentPlayerIndex && state.phase === 'PLAY'
            const isDealer = idx === state.dealerIndex
            return (
              <span key={p.id} className={`playerPill ${teamClassForSeat(state.players.length, idx)} ${isTurn ? 'turn' : ''} ${isDealer ? 'dealer' : ''}`}>
                {playerName(idx)}{isDealer ? ' D' : ''}
              </span>
            )
          })}
        </div>
      </div>
<div className={`tableWrap ${isMyTurn ? 'myTurn' : ''}`}>
  <div className="tableFelt" aria-label="table">
    {state.phase === 'GAME_END' && winnerTeam ? (
      <div className="winOverlayV2" role="status" aria-live="polite">
        <Confetti seed={confettiSeed} active={confettiOn} />
        <div className="winOverlayInnerV2">
          <div className="trophyV2">🏆</div>
          <div className="winTextV2"><span className="winNameV2">{teamDisplayName(winnerTeam.id)}</span> Wins!</div>
        </div>
      </div>
    ) : null}

    {/* Seat chips */}
    {(() => {
      const n = state.players.length
      const positions: Record<number, React.CSSProperties[]> = {
        2: [
          { left: '50%', top: 18, transform: 'translateX(-50%)' },
          { left: '50%', bottom: 18, transform: 'translateX(-50%)' }
        ],
        3: [
          { left: '50%', top: 18, transform: 'translateX(-50%)' },
          { left: 28, bottom: 22 },
          { right: 28, bottom: 22 }
        ],
        4: [
          { left: '50%', top: 18, transform: 'translateX(-50%)' },
          { right: 22, top: '50%', transform: 'translateY(-50%)' },
          { left: '50%', bottom: 18, transform: 'translateX(-50%)' },
          { left: 22, top: '50%', transform: 'translateY(-50%)' }
        ],
        6: [
          { left: '50%', top: 14, transform: 'translateX(-50%)' },
          { right: 28, top: 70 },
          { right: 28, bottom: 70 },
          { left: '50%', bottom: 14, transform: 'translateX(-50%)' },
          { left: 28, bottom: 70 },
          { left: 28, top: 70 }
        ]
      }
      const pos = positions[n] ?? []
      return (
        <>
          {state.players.map((p, i) => (
            <div
              key={p.id}
              className={`seatChip ${teamClassForSeat(state.players.length, i)} ${state.currentPlayerIndex === i ? 'seatChipActive' : ''} ${isMyTurn && net.playerIndex === i ? 'seatChipYourTurn' : ''} ${Date.now() < lingerUntil && lingerWinnerIndex === i ? 'seatChipWinner' : ''}`}
              style={pos[i] ?? {}}
            >
              <div className="seatChipInner">
                <div className="seatChipName">{playerName(i)}{i === net.playerIndex ? <span className="youTag"> You</span> : null}</div>
                <div className="seatChipMeta">
                  Seat {i + 1}{i === state.dealerIndex ? ' • Dealer' : ''}
                </div>
              </div>
            </div>
          ))}
        </>
      )
    })()}

    {/* Center pot always visible */}
    <div className="centerPot">
      <div className="playCenterLabel">
        <div className="playCenterTitle">Center</div>
        <div className="playCenterSub">
          {(() => {
	          if (!state) return 'Waiting'
            const now = Date.now()
	          const liveLen = state?.currentTrick?.plays?.length ?? 0
            const leader = liveLen
	            ? state?.currentTrick?.leaderIndex ?? null
              : (now < lingerUntil ? lingerLeaderIndex : null)

            if (leader != null && state.players[leader]) return `Led by ${playerName(leader)}`
            if (state.phase === 'PLAY') {
              const last = state.trickHistory && state.trickHistory.length ? state.trickHistory[state.trickHistory.length - 1] : null
              if (last && state.players[last.winnerIndex]) return `Last trick: ${playerName(last.winnerIndex)}`
              return 'Trick in progress'
            }
            return 'Waiting'
          })()}
        </div>
      </div>

      {(() => {
        const live = state.currentTrick?.plays ?? []
        const isLinger = !live.length && Date.now() < lingerUntil
        const show = live.length ? live : (isLinger ? lingerTrickPlays : [])
        if (!show.length) return null

        const nudge = isLinger && lingerWinnerIndex != null && lingerAnim === 'slide'
          ? winnerNudge(state.players.length, lingerWinnerIndex)
          : { x: 0, y: 0 }

        return (
          <div
            className={`trickCards ${isLinger ? 'trickCardsLinger' : ''} ${isLinger && lingerAnim === 'slide' ? 'trickCardsSlide' : ''}`}
            style={{
              marginTop: 10,
              display: 'flex',
              gap: 10,
              flexWrap: 'wrap',
              justifyContent: 'center',
              transform: `translate(${nudge.x}px, ${nudge.y}px)`
            }}
          >
            {show.map(pl => (
              <div key={`${pl.playerIndex}-${cardKey(pl.card)}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <span className={`cardFace cardEnter ${isRedSuit(pl.card.suit) ? 'red' : 'black'} ${isLinger && lingerWinnerIndex === pl.playerIndex ? 'winnerPulse' : ''}`} title={playerName(pl.playerIndex)}>
                  <span className="corner tl"><span className="cardRank">{pl.card.rank}</span><span className={`cardSuit ${isRedSuit(pl.card.suit) ? "redSuit" : ""}`}>{suitSymbol[pl.card.suit]}</span></span>
                  <span className={`pip ${isRedSuit(pl.card.suit) ? "redSuit" : ""}`}>{suitSymbol[pl.card.suit]}</span>
                  <span className="corner br"><span className="cardRank">{pl.card.rank}</span><span className={`cardSuit ${isRedSuit(pl.card.suit) ? "redSuit" : ""}`}>{suitSymbol[pl.card.suit]}</span></span>
                </span>
                <div className="small" style={{ color: 'rgba(255,255,255,0.92)' }}>{playerName(pl.playerIndex)}</div>
              </div>
            ))}
          </div>
        )
      })()}

      {state.phase === 'SETUP' && state.dealerIndex === net.playerIndex ? (
        <div className="centerCta">
          <button className="btn" onClick={() => send({ type: 'START_HAND' })}>
            Dealer: Start Hand
          </button>
        </div>
      ) : null}
    </div>
  </div>
</div>


{state.phase === 'GAME_END' ? (
  <div className="tableBox" style={{ marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
    <div>
      <div style={{ fontWeight: 900 }}>Rematch ready</div>
      <div className="small">
        {(() => {
          const needed = net.occupied.filter(Boolean).length
          const ready = net.occupied.reduce((acc, occ, i) => acc + (occ && net.rematchReady?.[i] ? 1 : 0), 0)
          return `${ready}/${needed} players ready`
        })()}
      </div>
    </div>

    {(() => {
      const seat = net.playerIndex
      const canReady = seat !== null && seat !== undefined && !!net.occupied?.[seat]
      const isReady = canReady ? !!net.rematchReady?.[seat] : false
      return (
        <button
          className="primary"
          onClick={canReady ? toggleRematchReady : undefined}
          disabled={!canReady}
          title={canReady ? (isReady ? 'Click to unready' : 'Click when you are ready to rematch') : 'Only seated players can ready up'}
        >
          {isReady ? 'Ready' : 'Click to Ready'}
        </button>
      )
    })()}
  </div>
) : null}

{showHistory ? (
  <>
    <div className="tableBox" style={{ marginTop: 10 }}>
      <div style={{ fontWeight: 950, marginBottom: 8 }}>Trick history</div>
      {state.trickHistory && state.trickHistory.length ? (
        state.trickHistory.slice().reverse().map(t => (
          <div key={t.trickNumber} style={{ marginBottom: 10 }}>
            <div className="small" style={{ opacity: 0.92 }}>
              Trick {t.trickNumber} | Leader: {playerName(t.leaderIndex)} | Winner: <strong>{playerName(t.winnerIndex)}</strong>
            </div>
            <div style={{ marginTop: 6 }}>
              {t.plays.map(pl => (
                <span
                  key={`${t.trickNumber}-${pl.playerIndex}-${cardKey(pl.card)}`}
                  className={`cardFace ${isRedSuit(pl.card.suit) ? 'red' : 'black'} ${pl.playerIndex === t.winnerIndex ? 'winnerGlow' : ''}`}
                  title={playerName(pl.playerIndex)}
                >
                  <span className="cardRank">{pl.card.rank}</span>
                  <span className={`cardSuit ${isRedSuit(pl.card.suit) ? "redSuit" : ""}`}>{suitSymbol[pl.card.suit]}</span>
                </span>
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="small">No completed tricks yet.</div>
      )}
    </div>
    <hr />
  </> 
) : null}

              </div>

      {showPlayers ? (
        <div className="playersModalWrap">
          <div className="modalBackdrop" onClick={() => setShowPlayers(false)} />
          <div className="playersModal">
            <div className="playersModalHeader">
              <div style={{ fontWeight: 900 }}>Players</div>
              <button className="btn" onClick={() => setShowPlayers(false)}>Close</button>
            </div>
            <div className="playersModalBody">
              {state.players.map((p, i) => (
                <div key={p.id} className="playersRow" style={{ pointerEvents: 'auto' }}>
                  <div className="playersRowLeft">
                    <div style={{ fontWeight: 800 }}>{playerName(i)}</div>
                    <div className="small" style={{ opacity: 0.85 }}>
                      Seat {i + 1}{i === state.dealerIndex ? ' • Dealer' : ''} • {state.teams[p.teamId]?.name ?? ''}
                    </div>
                  </div>
                  {net.isHost && i !== 0 ? (
                    <button
                      type="button"
                      className="btn danger"
                      style={{ position: 'relative', zIndex: 50, pointerEvents: 'auto' }}
                      onClick={() => {
                        console.log('[UI] Kick clicked seat=', i, 'isHost=', net.isHost)
                        hostKick(i)
                      }}
                    >
                      Kick
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

              <div className="card" style={{ margin: 0 }}>
<hr />

              {state.phase === 'BIDDING' ? (
                <>
                  <div className="small">
                    {net.error ? (<div className="errorBox" data-testid="BidErrorBanner" style={{ marginBottom: 8 }}>{net.error}</div>) : null}

                  Bidder: <strong>{state.currentBidderIndex != null ? playerName(state.currentBidderIndex) : '—'}</strong><br />
                    Current high bid: <strong>{currentHigh ? String(currentHigh) : 'None'}</strong><br />
                    You are: <strong>{net.playerIndex != null ? playerName(net.playerIndex) : 'Spectator'}</strong>
                  </div>

                  <hr />

{net.playerIndex !== null ? (
  <div className="small">
    <div><strong>Your hand</strong></div>
    <div className="tableBox handBox">
      {state.hands7[net.playerIndex].length ? state.hands7[net.playerIndex].map(c => (
        <span key={cardKey(c)} style={{ display: 'inline-flex' }}>
          <span className={`cardFace cardEnter ${isRedSuit(c.suit) ? 'red' : 'black'}`}>
            <span className="corner tl"><span className="cardRank">{c.rank}</span><span className="cardSuit">{suitSymbol[c.suit]}</span></span>
            <span className="pip">{suitSymbol[c.suit]}</span>
            <span className="corner br"><span className="cardRank">{c.rank}</span><span className="cardSuit">{suitSymbol[c.suit]}</span></span>
          </span>
        </span>
      )) : (
        <div className="small">No cards yet.</div>
      )}
    </div>
  </div>
) : (
  <div className="small">You are not seated, so your hand is hidden.</div>
)}

<hr />

                  {net.playerIndex !== null ? (
                    <div className="row" style={{ marginBottom: 10 }}>
                      <button
                        className="primary"
                        onClick={() => send({ type: 'MULLIGAN_7', playerIndex: net.playerIndex! })}
                        disabled={!(() => {
                          if (!state) return false
                          if (state.phase !== 'BIDDING') return false
                          if (state.mulliganUsed?.[net.playerIndex!] ) return false
                          if (state.bidHistory.some(b => b.playerIndex === net.playerIndex)) return false
                          const h = state.hands7[net.playerIndex!]
                          if (!h || h.length !== 7) return false
                          // Rank is a string union: '2'..'10'|'J'|'Q'|'K'|'A'
                          // Allow mulligan only if every card is numerically 10 or under.
                          return h.every(c => {
                            const n = Number(c.rank)
                            return Number.isFinite(n) && n <= 10
                          })
                        })()}
                        title="If your first 7 cards are all 10 or under, you may redeal 7 new cards before bidding."
                      >
                        Mulligan (Redeal 7)
                      </button>
                    </div>
                  ) : null}

                  <label>Suit for bid</label>
                  <select value={bidSuit} onChange={e => setBidSuit(e.target.value as Suit)} disabled={net.playerIndex === null}>
                    {suitOptions.map(s => (
                      <option key={s} value={s} style={{ color: isRedSuit(s) ? "#c00" : undefined }}>
                        {suitSymbol[s]} {suitLabel[s]}
                      </option>
                    ))}
                  </select>

                  <div className="row" style={{ marginTop: 12 }}>
                    {bidButtons.map(x => {
                      const isPass = x.b === 'PASS'
                      const disabled = isPass
                        ? ((canTakeOut ? false : !canBid('PASS')) || net.playerIndex !== state.currentBidderIndex)
                        : (!canBid(x.b) || net.playerIndex !== state.currentBidderIndex)

                      const onClick = () => {
                        if (isPass && canTakeOut) return takeOut()
                        return placeBid(x.b)
                      }

                      const label = isPass ? (canTakeOut ? 'Take the Out' : bidLabel('PASS')) : bidLabel(x.b)

                      return (
                        <button
                          key={String(x.b)}
                          className={x.primary ? 'primary' : ''}
                          disabled={disabled}
                          onClick={onClick}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>

                  <p className="small" style={{ marginTop: 10 }}>
                    Only the current bidder can click. Equal bids are not allowed.
                  </p>
                </>
              ) : null}

              {state.phase === 'DEALER_TRUMP' ? (
                <>
                  <div className="small">All players passed. Dealer is stuck with 2. Dealer must choose trump.</div>
                  <hr />

                  {net.playerIndex !== null ? (
                    <div className="small">
                      <div><strong>Your hand</strong></div>
                      <div className="tableBox">
                        {state.hands7[net.playerIndex].length ? state.hands7[net.playerIndex].map(c => (
                          <span
                            key={cardKey(c)}
                            className={`cardFace ${isRedSuit(c.suit) ? 'red' : 'black'}`}
                            style={{ display: 'inline-flex' }}
                          >
                            <span className="cardRank">{c.rank}</span>
                            <span className="cardSuit">{suitSymbol[c.suit]}</span>
                          </span>
                        )) : (
                          <div className="small">No cards yet.</div>
                        )}
                      </div>
                    </div>
                  ) : null}

                  <hr />
                  <div className="row">
                    {suitOptions.map(s => (
                      <button
                        key={s}
                        className="primary"
                        disabled={net.playerIndex !== state.dealerIndex}
                        onClick={() => send({ type: 'DEALER_SET_TRUMP', suit: s })}
                      >
                        {suitSymbol[s]} {suitLabel[s]}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}

              {state.phase === 'DISCARD' ? (
  <>
    <div className="phaseBanner">
      <div className="phaseTitle">Discard</div>
      <div className="phaseHint">
        {net.playerIndex === null
          ? 'Take a seat to discard.'
          : 'Tap cards to move between Keep and Discard. After you confirm, cards lock.'}
      </div>
      {net.playerIndex !== null && (!!state.discardDone[net.playerIndex] || discardSubmitting) ? (
        <span className="badge badgeLocked">Locked</span>
      ) : null}
    </div>

    <hr />

    <div className="row">
      <button
        className="primary"
        onClick={() => {
          setDiscardSubmitting(true)
          send({ type: 'CONFIRM_DISCARD', playerIndex: net.playerIndex! })
        }}
        disabled={net.playerIndex === null || state.discardDone[net.playerIndex] || discardSubmitting}
      >
        {discardSubmitting ? 'Confirming…' : (net.playerIndex !== null && state.discardDone[net.playerIndex] ? 'Confirmed' : 'Confirm Discards')}
      </button>

      <button
        className="primary"
        onClick={() => send({ type: 'REDEAL_TO_6' })}
        disabled={net.playerIndex !== state.dealerIndex || !state.discardDone.every(Boolean)}
      >
        Dealer Redeal to 6
      </button>
    </div>

    {(() => {
      const trump = state.trump
      const trumpSym = trump ? suitSymbol[trump] : ''
      const trumpName = trump ? suitLabel[trump] : 'Not selected'
      const trumpIsRed = trump === 'H' || trump === 'D'

      const bidWinnerName =
        state.bidWinnerIndex != null ? playerName(state.bidWinnerIndex) : 'None'
      const bidAmount =
        state.winningBid != null ? String(state.winningBid) : 'None'

      return (
        <div className="trumpBanner">
          <span className="trumpLabel">Trump:</span>
          {trump ? (
            <>
              <span className={`trumpSymbol ${trumpIsRed ? 'red' : 'black'}`}>{trumpSym}</span>
              <span className="trumpValue">{trumpName}</span>
            </>
          ) : (
            <span className="trumpValue">{trumpName}</span>
          )}

          <span className="trumpSep">·</span>

          <span className="trumpLabel">Bid:</span>
          <span className="trumpValue">{bidAmount}</span>

          <span className="trumpSep">·</span>

          <span className="trumpLabel">Won by:</span>
          <span className="trumpValue">{bidWinnerName}</span>
        </div>
      )
    })()}

    <div className="discardStatusList">
      <div className="small" style={{ marginBottom: 6 }}>Waiting on players</div>
      {state.players.map((_, i) => (
        <div key={i} className="discardStatusRow">
          <span className="discardStatusName">{playerName(i)}</span>
          <span className="discardStatusState">{state.discardDone[i] ? '✅ Confirmed' : '⏳ Waiting'}</span>
        </div>
      ))}
    </div>

    <hr />

    {net.playerIndex !== null ? (
      (() => {
        const baseOrder = (state.dealtHands7?.[net.playerIndex ?? 0] ?? discardHandLocal) as Card[]
        const cardKeyToIndex = new Map(baseOrder.map((c, i) => [cardKey(c), i]))
        const sortByDealtOrder = (a: Card, b: Card) =>
          (cardKeyToIndex.get(cardKey(a)) ?? 999) - (cardKeyToIndex.get(cardKey(b)) ?? 999)
        const sortedKeepCards = [...discardHandLocal].sort(sortByDealtOrder)
        const sortedDiscardList = [...discardPileLocal].sort(sortByDealtOrder)
        const pi = net.playerIndex!
        const discardsLocked = !!state.discardDone?.[pi] || discardSubmitting
        const handleDiscardToggle = (e: React.PointerEvent, c: Card) => {
          if (discardsLocked) return
          e.preventDefault()
          e.stopPropagation()
          const id = cardKey(c)
          const inHand = discardHandLocal.some(h => cardKey(h) === id)
          if (inHand) {
            const idx = discardHandLocal.findIndex(h => cardKey(h) === id)
            if (idx === -1) return
            const card = discardHandLocal[idx]
            setDiscardHandLocal(prev => prev.filter((_, i) => i !== idx))
            setDiscardPileLocal(prev => [...prev, card])
            setDiscardSelectedIds(prev => new Set(prev).add(id))
          } else {
            const idx = discardPileLocal.findIndex(h => cardKey(h) === id)
            if (idx === -1) return
            const card = discardPileLocal[idx]
            setDiscardPileLocal(prev => prev.filter((_, i) => i !== idx))
            setDiscardHandLocal(prev => [...prev, card])
            setDiscardSelectedIds(prev => {
              const next = new Set(prev)
              next.delete(id)
              return next
            })
          }
          send({ type: 'TOGGLE_DISCARD', playerIndex: net.playerIndex!, card: c })
        }
        return (
      <div className="discardPhase small">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div><strong>Keep</strong>{discardsLocked ? <span className="badge badgeLocked" style={{ marginLeft: 8 }}>Locked</span> : null}</div>
          <div className="small" style={{ opacity: 0.9 }}>Tap to discard</div>
        </div>

        <div className="tableBox discardPileGrid">
          {sortedKeepCards.map(c => (
            <button
              type="button"
              key={cardKey(c)}
              className="cardBtn playable discardCardBtn discardNoBounce"
              title="Move to Discard"
              disabled={discardsLocked}
              onPointerDown={(e) => handleDiscardToggle(e, c)}
            >
              <span className={`cardFace ${isRedSuit(c.suit) ? 'red' : 'black'}`}>
                <span className="corner tl"><span className="cardRank">{c.rank}</span><span className="cardSuit">{suitSymbol[c.suit]}</span></span>
                <span className="pip">{suitSymbol[c.suit]}</span>
                <span className="corner br"><span className="cardRank">{c.rank}</span><span className="cardSuit">{suitSymbol[c.suit]}</span></span>
              </span>
            </button>
          ))}
          {!sortedKeepCards.length ? <div className="small">No cards in Keep.</div> : null}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
          <div><strong>Discard</strong>{discardsLocked ? <span className="badge badgeLocked" style={{ marginLeft: 8 }}>Locked</span> : null}</div>
          <div className="small" style={{ opacity: 0.9 }}>Tap to return</div>
        </div>

        <div className="tableBox discardPileGrid">
          {sortedDiscardList.map(c => (
            <button
              type="button"
              key={cardKey(c)}
              className="cardBtn playable discardCardBtn discardNoBounce"
              title="Move back to Keep"
              disabled={discardsLocked}
              onPointerDown={(e) => handleDiscardToggle(e, c)}
            >
              <span className={`cardFace ${isRedSuit(c.suit) ? 'red' : 'black'}`}>
                <span className="corner tl"><span className="cardRank">{c.rank}</span><span className="cardSuit">{suitSymbol[c.suit]}</span></span>
                <span className="pip">{suitSymbol[c.suit]}</span>
                <span className="corner br"><span className="cardRank">{c.rank}</span><span className="cardSuit">{suitSymbol[c.suit]}</span></span>
              </span>
            </button>
          ))}
          {!sortedDiscardList.length ? <div className="small">No discarded cards.</div> : null}
        </div>
      </div>
        )
      })()
    ) : (
      <div className="small">Take a seat to discard.</div>
    )}
  </>
) : null}
{state.phase === 'PLAY' ? (
  <>
    <div className="small">
      Trick <strong>{state.trickNumber}</strong> | Trump: <strong>{state.trump ? suitLabel[state.trump] : 'None'}</strong>
      <br />
      Current turn: <strong>{playerName(state.currentPlayerIndex)}</strong>
    </div>

    <hr />

    {net.playerIndex !== null ? (
      <div className="small">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div><strong>Your hand</strong></div>
          <div className="small" style={{ opacity: 0.9 }}>
            {(() => {
              const lead = state.currentTrick && state.currentTrick.plays.length ? state.currentTrick.plays[0].card.suit : null
              const mustLeadTrump = !!(state.trump && state.trickNumber === 1 && state.currentTrick && state.currentTrick.plays.length === 0 && state.currentTrick.leaderIndex === state.currentPlayerIndex)
              const playable = legalPlays(state.hands6[net.playerIndex], lead, state.trump, mustLeadTrump)
              if (mustLeadTrump) return `First lead must be Trump: ${suitLabel[state.trump!]} (${playable.length} playable)`
              if (!lead) return 'Lead any card'
              if (state.trump && lead !== state.trump) return `Play ${suitLabel[lead]} or Trump (${playable.length} playable)`
              return `Must follow: ${suitLabel[lead]} (${playable.length} playable)`
            })()}
          </div>
        </div>

        <div className="tableBox">
          {(() => {
            const lead = state.currentTrick && state.currentTrick.plays.length ? state.currentTrick.plays[0].card.suit : null
	            const mustLeadTrump = !!(state.trump && state.trickNumber === 1 && state.currentTrick && state.currentTrick.plays.length === 0 && state.currentTrick.leaderIndex === state.currentPlayerIndex)
	            const playable = legalPlays(state.hands6[net.playerIndex], lead, state.trump, mustLeadTrump)
            return state.hands6[net.playerIndex].map(c => {
              const okSuit = playable.some(pc => sameCard(pc, c))
              const isMyTurn = net.playerIndex === state.currentPlayerIndex
              const ok = isMyTurn && okSuit
              return (
                <button
                  key={cardKey(c)}
                  className={`cardBtn ${ok ? 'playable' : 'blocked'}`}
                  disabled={!ok}
                  onClick={() => { sfx.play('tap'); send({ type: 'PLAY_CARD', card: c }) }}
                  title={!isMyTurn ? 'Not your turn' : (okSuit ? 'Play card' : (mustLeadTrump ? 'First lead must be trump' : 'Must follow suit'))}
                >
                  <span className={`cardFace cardEnter ${isRedSuit(c.suit) ? 'red' : 'black'}`}>
  <span className="corner tl"><span className="cardRank">{c.rank}</span><span className="cardSuit">{suitSymbol[c.suit]}</span></span>
  <span className="pip">{suitSymbol[c.suit]}</span>
  <span className="corner br"><span className="cardRank">{c.rank}</span><span className="cardSuit">{suitSymbol[c.suit]}</span></span>
</span>
                </button>
              )
            })
          })()}
          {!state.hands6[net.playerIndex].length ? <div className="small">No cards left.</div> : null}
        </div>
      </div>
    ) : (
      <div className="small">Take a seat to see your hand.</div>
    )}
  </>
) : null}

              {state.phase === 'SCORE_HAND' ? (
                <>
                  <div className="small">Hand complete. Review scoring.</div>

                  <hr />

                  {state.lastHandResult ? (
                    <>
                      <div className="small">
                        Bidder team: <strong>{teamRosterLabel(state, state.lastHandResult!.bidderTeamId)}</strong><br />
                        Winning bid: <strong>{String(state.lastHandResult.winningBid)}</strong><br />
                        Trump: <strong>{suitSymbol[state.lastHandResult.trump]} {suitLabel[state.lastHandResult.trump]}</strong>
                      </div>

                      <hr />

                      <h3>Team results</h3>
                      {state.lastHandResult.teamScores.map(ts => {
                        const teamName = teamRosterLabel(state, ts.teamId)
                        const isBidderTeam = ts.teamId === state.lastHandResult!.bidderTeamId
                        return (
                          <div key={ts.teamId} className="tableBox" style={{ marginBottom: 10 }}>
                            <div style={{ fontWeight: 950 }}>
                              {teamName}{isBidderTeam ? ' (Bidder)' : ''}
                            </div>
                            <div className="small">
                              Categories: {ts.categoriesWon.length ? ts.categoriesWon.map(categoryName).join(', ') : 'None'}<br />
                              Hand points: <strong>{ts.totalHandPoints}</strong><br />
                              Game points: {ts.gamePoints}
                            </div>
                          </div>
                        )
                      })}

                      <hr />

                      <div className="small">
                        {state.lastHandResult.notes.map((n, i) => <div key={i}>{n}</div>)}
                      </div>

                      <hr />

                      <button
                        className="primary"
                        onClick={() => send({ type: 'APPLY_SCORE_AND_NEXT_HAND' })}
                        disabled={net.playerIndex !== state.dealerIndex}
                      >
                        Dealer: Apply Score and Next Hand
                      </button>
                    </>
                  ) : (
                    <div className="small">No hand result found.</div>
                  )}
                </>
              ) : null}

              {state.phase === 'GAME_END' ? (
                <>
                  <div className="small">Game over.</div>

                  <hr />

                  {winnerTeam ? (
                    <div className="tableBox">
                      <div style={{ fontWeight: 950 }}>Winner: {winnerTeam.name}</div>
                      <div className="small">Final score: {winnerTeam.score}</div>
                    </div>
                  ) : (
                    <div className="small">A team reached the target score, or Shoot The Moon succeeded.</div>
                  )}

                                  </>
              ) : null}

              <hr />

              <h3>Log</h3>
              <div className="small" style={{ maxHeight: 220, overflow: 'auto' }}>
                {state.messageLog.slice().reverse().map((m, i) => (
                  <div key={i}>{m}</div>
                ))}
              </div>
              </div>
              </div>
            </div>

            {state && (state.phase === 'SETUP' || state.phase === 'GAME_END') ? (
              <div className="card" style={{ marginTop: 12 }}>
                <h3>Seats</h3>
                <div className="small">Choose where you want to sit.</div>

                <div style={{ display:'flex', flexDirection:'column', gap:8, marginTop:10 }}>
                  {state.players.map((p, i) => {
                    const isMe = net.playerIndex === i
                    const occupied = !!net.occupied?.[i]

                    return (
                      <div key={i} className="tableBox" style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}>
                        <div>
                          <div style={{ fontWeight:900 }}>
                            {playerName(i)} {isMe ? '(You)' : ''}
                          </div>
                          <div className="small">
                            Seat {i+1}
                            {state.phase === 'SETUP' && (
                              <span
                                className={`teamPreview teamPreview${previewTeamForSeat(state.players.length, i)}`}
                                style={{ marginLeft: 8 }}
                              >
                                Team {String.fromCharCode(65 + previewTeamForSeat(state.players.length, i))}
                              </span>
                            )}
                          </div>
                        </div>

                        {isMe ? (
                          <button className="btn danger" onClick={leaveSeat}>
                            Leave Seat
                          </button>
                        ) : (
                          <button
                            className="btn primary"
                            disabled={occupied}
                            onClick={() => takeSeat(i)}
                          >
                            {occupied ? 'Taken' : 'Take Seat'}
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}

            <div style={{ minWidth: 0 }}>
              <div className="card" style={{ margin: 0 }}>
                <ChatPanel
                  title="Table Chat"
                  messages={chatMessages}
                  disabled={!net.socket?.connected || !roomReady}
                  onSend={onSendChat}
                  loading={chatLoading}
                  error={chatError}
                />
              </div>
            </div>
          </div>
        </>
      ) : null}
    
      
      {profileOpen ? (
        <div className="modalBackdrop" onClick={() => setProfileOpen(false)}>
          <div className="modalCard" onClick={(e) => e.stopPropagation()}>
            <div className="modalTitle">Profile</div>
            <div className="small profileUserName" style={{ marginTop: 6, marginBottom: 10 }}>
              {authUser ? `Logged in as ${authUser.username}` : ''}
            </div>

            {profileError ? (
              <div className="toast toastError" style={{ marginBottom: 10 }}>{profileError}</div>
            ) : null}

            {profileStats ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>Games played</div>
                  <div style={{ fontWeight: 900 }}>{profileStats.gamesPlayed}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>Wins</div>
                  <div style={{ fontWeight: 900 }}>{profileStats.wins}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>Losses</div>
                  <div style={{ fontWeight: 900 }}>{profileStats.losses}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>Win percentage</div>
                  <div style={{ fontWeight: 900 }}>{pct(profileStats.winPct)}</div>
                </div>

                <div style={{ height: 1, background: 'rgba(255,255,255,0.12)', margin: '2px 0' }} />

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>Bids won</div>
                  <div style={{ fontWeight: 900 }}>{profileStats.bidsWon}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>Bids made</div>
                  <div style={{ fontWeight: 900 }}>{profileStats.bidsMade}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>Bid win percentage</div>
                  <div style={{ fontWeight: 900 }}>{pct(profileStats.bidWinPct)}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>Shoot the Moon success</div>
                  <div style={{ fontWeight: 900 }}>{profileStats.stmSuccess}</div>
                </div>

                {profileStats.updatedAt ? (
                  <div className="small" style={{ opacity: 0.85, marginTop: 4 }}>
                    Updated {new Date(profileStats.updatedAt).toLocaleString()}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="small" style={{ opacity: 0.9 }}>
                {profileBusy ? 'Loading stats...' : 'No stats yet.'}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => void loadProfileStats()} disabled={profileBusy || !authUser}>
                {profileBusy ? 'Loading...' : 'Refresh'}
              </button>
              <button className="btn" onClick={() => setProfileOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}

{inviteLink ? (
        <div className="modalBackdrop" onClick={() => setInviteLink(null)}>
          <div className="modalCard" onClick={(e) => e.stopPropagation()}>
            <div className="modalTitle">Invite friends</div>
            <div className="small" style={{ marginTop: 6, marginBottom: 10 }}>
              Share this link. Opening it will auto join your room.
            </div>

            <input className="modalInput" readOnly value={inviteLink} onFocus={(e) => e.currentTarget.select()} />

            <div className="small" style={{ marginTop: 10, marginBottom: 6 }}>
              Watch link (spectator)
            </div>
            <input
              className="modalInput"
              readOnly
              value={inviteLink.includes('?') ? `${inviteLink}&spectate=1` : `${inviteLink}?spectate=1`}
              onFocus={(e) => e.currentTarget.select()}
            />

            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => void copyToClipboard(inviteLink)}>Copy</button>
              <button
                className="btn"
                onClick={() => void copyToClipboard(inviteLink.includes('?') ? `${inviteLink}&spectate=1` : `${inviteLink}?spectate=1`)}
              >
                Copy watch link
              </button>
              {inviteShareSupported ? (
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      await (navigator as any).share({ title: 'Cuse Pitch Invite', text: 'Join my Cuse Pitch game', url: inviteLink })
                    } catch {}
                  }}
                >
                  Share
                </button>
              ) : null}
              <button className="btn" onClick={() => setInviteLink(null)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}

</div>
  )
}
