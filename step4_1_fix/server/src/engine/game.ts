import { Action, BidEntry, BidKind, Card, Category, GameSettings, GameState, HandResult, Player, Rank, Suit, Team, TeamHandScore, TrickState } from './types'

export const suitLabel: Record<Suit, string> = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' }
export const suitSymbol: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' }

const SUITS: Suit[] = ['S','H','D','C']
const RANKS: Rank[] = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']

export function cardKey(c: Card): string { return `${c.rank}${c.suit}` }

function log(state: GameState, msg: string): GameState { return { ...state, messageLog: [...state.messageLog, msg] } }

function buildDeck(): Card[] {
  const d: Card[] = []
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r })
  return d
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function buildPlayersTeams(settings: GameSettings, names?: string[]): { players: Player[], teams: Team[] } {
  const pc = settings.playerCount
  const players: Player[] = []
  const teams: Team[] = []
  const nm = (i: number) => (names?.[i] ?? `Player ${i + 1}`)

  if (pc === 2) {
    teams.push({ id: 'A', name: 'Team A', score: 0, sets: 0 }, { id: 'B', name: 'Team B', score: 0, sets: 0 })
    players.push({ id: 'P1', name: nm(0), teamId: 'A' }, { id: 'P2', name: nm(1), teamId: 'B' })
  } else if (pc === 3) {
    teams.push({ id: 'T1', name: nm(0), score: 0, sets: 0 }, { id: 'T2', name: nm(1), score: 0, sets: 0 }, { id: 'T3', name: nm(2), score: 0, sets: 0 })
    players.push({ id: 'P1', name: nm(0), teamId: 'T1' }, { id: 'P2', name: nm(1), teamId: 'T2' }, { id: 'P3', name: nm(2), teamId: 'T3' })
  } else if (pc === 4) {
    teams.push({ id: 'A', name: 'Team A', score: 0, sets: 0 }, { id: 'B', name: 'Team B', score: 0, sets: 0 })
    players.push(
      { id: 'P1', name: nm(0), teamId: 'A' },
      { id: 'P2', name: nm(1), teamId: 'B' },
      { id: 'P3', name: nm(2), teamId: 'A' },
      { id: 'P4', name: nm(3), teamId: 'B' },
    )
    } else if (pc === 6) {
    teams.push(
      { id: 'A', name: 'Team A', score: 0, sets: 0 },
      { id: 'B', name: 'Team B', score: 0, sets: 0 },
      { id: 'C', name: 'Team C', score: 0, sets: 0 },
    )
    players.push(
      { id: 'P1', name: nm(0), teamId: 'A' },
      { id: 'P2', name: nm(1), teamId: 'B' },
      { id: 'P3', name: nm(2), teamId: 'C' },
      { id: 'P4', name: nm(3), teamId: 'A' },
      { id: 'P5', name: nm(4), teamId: 'B' },
      { id: 'P6', name: nm(5), teamId: 'C' },
    )
  } else {
    teams.push({ id: 'A', name: 'Team A', score: 0, sets: 0 }, { id: 'B', name: 'Team B', score: 0, sets: 0 })
    players.push(
      { id: 'P1', name: nm(0), teamId: 'A' },
      { id: 'P2', name: nm(1), teamId: 'B' },
      { id: 'P3', name: nm(2), teamId: 'A' },
      { id: 'P4', name: nm(3), teamId: 'B' },
      { id: 'P5', name: nm(4), teamId: 'A' },
      { id: 'P6', name: nm(5), teamId: 'B' },
    )
  }

  return { players, teams }
}

function emptyHands(pc: number): Card[][] { return Array.from({ length: pc }, () => []) }

function initTeamMaps(teams: Team[]): { tricksWonByTeamId: Record<string, number>, cardsCapturedByTeamId: Record<string, Card[]> } {
  const tw: Record<string, number> = {}
  const cc: Record<string, Card[]> = {}
  for (const t of teams) { tw[t.id] = 0; cc[t.id] = [] }
  return { tricksWonByTeamId: tw, cardsCapturedByTeamId: cc }
}

export function newGame(settings: GameSettings, names?: string[]): GameState {
  const { players, teams } = buildPlayersTeams(settings, names)
  const pc = players.length
  const maps = initTeamMaps(teams)

  return {
    settings,
    players,
    teams,
    dealerIndex: 0,
    handNumber: 0,
    phase: 'SETUP',

    deck: [],
    deckPos: 0,
    hands7: emptyHands(pc),
    dealtHands7: emptyHands(pc),

    trump: null,
    bidHistory: [],
    currentBidderIndex: 0,
    bidWinnerIndex: null,
    bidWinnerTeamId: null,
    winningBid: null,

    discardPiles: emptyHands(pc),
    discardDone: Array.from({ length: pc }, () => false),
    hands6: emptyHands(pc),
      mulliganUsed: Array.from({ length: pc }, () => false),

    currentPlayerIndex: 0,
    trickNumber: 0,
    currentTrick: null,
    trickHistory: [],
    tricksWonByTeamId: maps.tricksWonByTeamId,
    cardsCapturedByTeamId: maps.cardsCapturedByTeamId,

    lastHandResult: null,
    winnerTeamId: null,

    statsByPlayerId: Object.fromEntries(players.map(p => [p.id, { handsPlayed: 0, tricksWon: 0, stmAttempts: 0, stmSuccess: 0, stmFail: 0, bidsWon: 0, bidsMade: 0 }])),

    messageLog: ['Ready. Start a hand.'],
  }
}

function bidStrength(b: Exclude<BidKind,'PASS'>): number { return b === 'STM' ? 5 : b }

export function currentHighBid(history: BidEntry[]): Exclude<BidKind,'PASS'> | null {
  let best: Exclude<BidKind,'PASS'> | null = null
  for (const h of history) {
    if (h.bid === 'PASS') continue
    const b = h.bid as Exclude<BidKind,'PASS'>
    if (!best || bidStrength(b) > bidStrength(best)) best = b
  }
  return best
}

function deal7(state: GameState): { deck: Card[], deckPos: number, hands7: Card[][] } {
  const pc = state.players.length
  const deck = shuffle(buildDeck())
  const hands7 = emptyHands(pc)
  let pos = 0
  for (let r = 0; r < 7; r++) for (let p = 0; p < pc; p++) hands7[p].push(deck[pos++])
  return { deck, deckPos: pos, hands7 }
}

function resolveBidding(state: GameState): GameState {
  const nonPass = state.bidHistory.filter(b => b.bid !== 'PASS')
  if (nonPass.length === 0) {
    const dealer = state.dealerIndex
    const t = state.players[dealer].teamId
    let out: GameState = {
      ...state,
      bidWinnerIndex: dealer,
      bidWinnerTeamId: t,
      winningBid: 2,
      trump: null,
      phase: 'DEALER_TRUMP',
      currentBidderIndex: dealer,
      currentPlayerIndex: dealer,
    }
    out = log(out, 'All passed. Dealer is stuck with 2 and must choose trump.')
    return out
  }

  let best = nonPass[0]
  for (const h of nonPass) {
    const hb = h.bid as Exclude<BidKind,'PASS'>
    const bb = best.bid as Exclude<BidKind,'PASS'>
    if (bidStrength(hb) > bidStrength(bb)) best = h
  }

  const winner = best.playerIndex
  const trump = best.suit as Suit
  let out: GameState = {
    ...state,
    bidWinnerIndex: winner,
    bidWinnerTeamId: state.players[winner].teamId,
    winningBid: best.bid as Exclude<BidKind,'PASS'>,
    trump,
    phase: 'DISCARD',
    currentPlayerIndex: state.dealerIndex,
    hands7: (state.hands7.some(h => h.length) ? state.hands7 : state.dealtHands7),
    discardPiles: emptyHands(state.players.length),
    discardDone: Array.from({ length: state.players.length }, () => false),
    hands6: emptyHands(state.players.length),
  }
  out = log(out, `${state.players[winner].name} won the bid. Trump is ${suitLabel[trump]}.`)
  out = log(out, 'Discard phase. Each player may discard any number of cards.')
  return out
}

function inHand(hand: Card[], card: Card): boolean { return hand.some(c => c.rank === card.rank && c.suit === card.suit) }

function removeCard(hand: Card[], card: Card): Card[] {
  const idx = hand.findIndex(c => c.rank === card.rank && c.suit === card.suit)
  if (idx < 0) return hand
  const next = hand.slice()
  next.splice(idx, 1)
  return next
}

function addCard(hand: Card[], card: Card): Card[] { return hand.concat([card]) }

function canFollowSuit(hand: Card[], suit: Suit): boolean { return hand.some(c => c.suit === suit) }

const trickRankOrder: Rank[] = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']
function rankValueForTrick(r: Rank): number { return trickRankOrder.indexOf(r) }

function trickWinnerIndex(plays: { playerIndex: number, card: Card }[], trump: Suit): number {
  const leadSuit = plays[0].card.suit
  let best = plays[0]

  for (const p of plays.slice(1)) {
    const a = best.card
    const b = p.card
    const aTrump = a.suit === trump
    const bTrump = b.suit === trump

    if (aTrump && !bTrump) continue
    if (!aTrump && bTrump) { best = p; continue }

    const suitToCompare = aTrump ? trump : leadSuit
    if (b.suit !== suitToCompare && a.suit === suitToCompare) continue
    if (b.suit === suitToCompare && a.suit !== suitToCompare) { best = p; continue }

    if (rankValueForTrick(b.rank) > rankValueForTrick(a.rank)) best = p
  }

  return best.playerIndex
}

const gamePointValue: Record<Rank, number> = { '10': 10, A: 4, K: 3, Q: 2, J: 1, '9': 0, '8': 0, '7': 0, '6': 0, '5': 0, '4': 0, '3': 0, '2': 0 }

function rankValueLow(r: Rank): number { return trickRankOrder.indexOf(r) }

function computeHandResult(state: GameState): HandResult {
  const trump = state.trump as Suit
  const bidderPlayerIndex = state.bidWinnerIndex as number
  const bidderTeamId = state.bidWinnerTeamId as string
  const winningBid = state.winningBid as Exclude<BidKind,'PASS'>

  const notes: string[] = []
  const teamIds = state.teams.map(t => t.id)

  // Gather trump cards captured by team
  const trumpCapturedByTeam: Record<string, Card[]> = {}
  for (const tid of teamIds) {
    trumpCapturedByTeam[tid] = (state.cardsCapturedByTeamId[tid] ?? []).filter(c => c.suit === trump)
  }

  // Determine global high/low trump (by rank) and which team captured
  let highCard: Card | null = null
  let highTeam: string | null = null
  let lowCard: Card | null = null
  let lowTeam: string | null = null
  let jackTeam: string | null = null

  for (const tid of teamIds) {
    for (const c of trumpCapturedByTeam[tid]) {
      if (!highCard || rankValueForTrick(c.rank) > rankValueForTrick(highCard.rank)) { highCard = c; highTeam = tid }
      if (!lowCard || rankValueLow(c.rank) < rankValueLow(lowCard.rank)) { lowCard = c; lowTeam = tid }
      if (c.rank === 'J') jackTeam = tid
    }
  }

  // Compute game points per team from all captured cards
  const gamePoints: Record<string, number> = {}
  for (const tid of teamIds) {
    const captured = state.cardsCapturedByTeamId[tid] ?? []
    let gp = 0
    for (const c of captured) gp += (gamePointValue[c.rank] ?? 0)
    gamePoints[tid] = gp
  }

  // Game point winner must be unique highest
  let gameWinner: string | null = null
  let best = -1
  let tied = false
  for (const tid of teamIds) {
    const gp = gamePoints[tid]
    if (gp > best) { best = gp; gameWinner = tid; tied = false }
    else if (gp === best) { tied = true }
  }
  if (tied) gameWinner = null

  // Build TeamHandScore
  const teamScores: TeamHandScore[] = teamIds.map(tid => {
    const categoriesWon: Category[] = []
    if (highTeam === tid) categoriesWon.push('HIGH')
    if (lowTeam === tid) categoriesWon.push('LOW')
    if (jackTeam === tid) categoriesWon.push('JACK')
    if (gameWinner === tid) categoriesWon.push('GAME')

    const categoryPoints = categoriesWon.length
    const gp = gamePoints[tid]
    return { teamId: tid, categoriesWon, categoryPoints, gamePoints: gp, totalHandPoints: categoryPoints }
  })

  const bidderPoints = teamScores.find(t => t.teamId === bidderTeamId)?.totalHandPoints ?? 0
  const bidderMadeBid = winningBid === 'STM' ? false : bidderPoints >= winningBid

  // STM checks
  const bidderTricks = state.tricksWonByTeamId[bidderTeamId] ?? 0
  const stmSucceeded = winningBid === 'STM' && bidderTricks === 6 && bidderPoints === 4
  const stmFailed = winningBid === 'STM' && !stmSucceeded

  if (highCard) notes.push(`High trump: ${highCard.rank}${suitSymbol[highCard.suit]}`)
  if (lowCard) notes.push(`Low trump: ${lowCard.rank}${suitSymbol[lowCard.suit]}`)
  if (jackTeam) notes.push(`Jack of trump captured`)
  if (!gameWinner) notes.push('Game was tied or no winner')

  const stmPenalty = stmFailed ? state.settings.targetScore : 0
  const bidderSetPenalty = (!stmFailed && winningBid !== 'STM' && !bidderMadeBid) ? winningBid : 0

  if (winningBid !== 'STM') {
    if (bidderMadeBid) notes.push(`Bid made: ${bidderPoints} points`)
    else notes.push(`Bid failed: ${bidderPoints} points, set for ${winningBid}`)
  } else {
    if (stmSucceeded) notes.push('Shoot The Moon succeeded')
    else notes.push(`Shoot The Moon failed, set for ${state.settings.targetScore}`)
  }

  return {
    bidderTeamId,
    bidderPlayerIndex,
    winningBid,
    trump,
    stmSucceeded,
    stmFailed,
    stmPenalty,
    bidderMadeBid: winningBid === 'STM' ? false : bidderMadeBid,
    bidderSetPenalty,
    teamScores,
    notes,
  }
}

function applyHandScoring(state: GameState, result: HandResult): { teams: Team[], winnerTeamId: string | null } {
  const teams = state.teams.map(t => ({ ...t }))
  const tidToDelta: Record<string, number> = {}
  for (const t of result.teamScores) tidToDelta[t.teamId] = t.totalHandPoints

  // Apply base points to all teams
  for (const t of teams) t.score += (tidToDelta[t.id] ?? 0)

  // Apply bid failure penalties
  const bidderTeam = teams.find(t => t.id === result.bidderTeamId)
  if (bidderTeam) {
    if (result.stmFailed) { bidderTeam.score -= result.stmPenalty; bidderTeam.sets += 1 }
    else if (result.bidderSetPenalty > 0) { bidderTeam.score -= result.bidderSetPenalty; bidderTeam.sets += 1 }
  }

  // STM success = immediate win
  if (result.stmSucceeded) return { teams, winnerTeamId: result.bidderTeamId }

  // Normal win condition: first team to reach targetScore or higher
  const target = state.settings.targetScore
  const winner = teams.find(t => t.score >= target)?.id ?? null
  return { teams, winnerTeamId: winner }
}

export function reducer(state: GameState, action: Action): GameState {
  if (action.type === 'NEW_GAME') return newGame(action.settings, action.names)

  if (action.type === 'SET_TARGET') return { ...state, settings: { ...state.settings, targetScore: action.targetScore } }

  if (action.type === 'SET_PLAYERCOUNT') {
    const settings = { ...state.settings, playerCount: action.playerCount }
    const names = state.players.map(p => p.name)
    return newGame(settings, names)
  }

  if (action.type === 'SET_NAME') {
    const players = state.players.map(p => ({ ...p }))
    players[action.playerIndex].name = action.name
    const teams = state.teams.map(t => ({ ...t }))
    if (state.settings.playerCount === 3) {
      const tid = players[action.playerIndex].teamId
      const team = teams.find(t => t.id === tid)
      if (team) team.name = action.name
    }
    return { ...state, players, teams }
  }

  if (action.type === 'START_HAND') {
    if (state.phase !== 'SETUP') return state
    const pc = state.players.length
    const startBidder = (state.dealerIndex + 1) % pc
    const dealt = deal7(state)
    const maps = initTeamMaps(state.teams)
    const newHandNumber = state.handNumber + 1
    const handId = `h-${newHandNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`

    let out: GameState = {
      ...state,
      phase: 'BIDDING',
      handNumber: newHandNumber,
      handId,
      trump: null,
      bidHistory: [],
      currentBidderIndex: startBidder,
      bidWinnerIndex: null,
      bidWinnerTeamId: null,
      winningBid: null,
      currentPlayerIndex: startBidder,
      trickHistory: [],

      deck: dealt.deck,
      deckPos: dealt.deckPos,
      hands7: dealt.hands7,
      dealtHands7: dealt.hands7.map(h => h.slice()),

      discardPiles: emptyHands(pc),
      discardDone: Array.from({ length: pc }, () => false),
      hands6: emptyHands(pc),

      trickNumber: 0,
      currentTrick: null,
      tricksWonByTeamId: maps.tricksWonByTeamId,
      cardsCapturedByTeamId: maps.cardsCapturedByTeamId,

      lastHandResult: null,
    }
    out = log(out, `Hand ${out.handNumber}. Dealt 7. Bidding starts left of dealer.`)
    return out
  }

  if (action.type === 'MULLIGAN_7') {
  if (state.phase !== 'BIDDING') return state
  const pi = action.playerIndex
  if (pi < 0 || pi >= state.players.length) return state
  if (state.mulliganUsed?.[pi]) return log(state, 'Mulligan already used this hand.')
  // Only allow if player has not yet bid this round
  if (state.bidHistory.some(b => b.playerIndex === pi)) return log(state, 'You can only mulligan before you bid.')
  const hand = state.hands7[pi] ?? []
  const allTenOrUnder = hand.length === 7 && hand.every(c => {
    // Rank is a string union: '2'..'10'|'J'|'Q'|'K'|'A'
    // Allow mulligan only if every card is numerically 10 or under.
    const n = Number(c.rank)
    return Number.isFinite(n) && n <= 10
  })
  if (!allTenOrUnder) return log(state, 'Mulligan allowed only if all 7 cards are 10 or under.')

  // Discard all 7 and deal 7 new cards from deck
  let pos = state.deckPos
  const newHand: Card[] = []
  while (newHand.length < 7 && pos < state.deck.length) newHand.push(state.deck[pos++])

  // In BIDDING phase we expect hands7 to be populated, but keep a safe fallback.
  const baseHands7 = state.hands7.some(h => h.length) ? state.hands7 : state.dealtHands7
  const hands7 = baseHands7.map(h => h.slice())
  hands7[pi] = newHand

  const mull = state.mulliganUsed.slice()
  mull[pi] = true

  let out: GameState = { ...state, hands7, deckPos: pos, mulliganUsed: mull }
  out = log(out, `${state.players[pi].name} took a mulligan (7 new cards).`)
  return out
}


  if (action.type === 'TAKE_OUT') {
    if (state.phase !== 'BIDDING') return state
    const pc = state.players.length
    const p = state.currentBidderIndex
    const priorHigh = currentHighBid(state.bidHistory)

    // Only allowed when no one has made a non-pass bid, and the current bidder would otherwise be forced.
    // Robust to mulligans/reconnects: we check each other player's most recent bid is PASS.
    if (priorHigh) return log(state, 'Take the Out is only allowed when no bid has been made.')
    const lastByPlayer = new Map<number, BidKind>()
    for (const h of state.bidHistory) lastByPlayer.set(h.playerIndex, h.bid)
    // Current bidder must not have already bid in this bidding cycle
    if (lastByPlayer.has(p)) return log(state, 'Take the Out is only available to the current bidder before they bid.')
    for (let pi = 0; pi < pc; pi++) {
      if (pi === p) continue
      if (lastByPlayer.get(pi) !== 'PASS') return log(state, 'Take the Out is only allowed when everyone else passed.')
    }

    const teamId = state.players[p].teamId
    const nextTeams = state.teams.map(t => t.id === teamId ? { ...t, score: t.score - 2 } : t)
    const maps = initTeamMaps(nextTeams)
    const nextDealer = (state.dealerIndex + 1) % pc
    const rosterName = state.players.filter(pl => pl.teamId === teamId).map(pl => pl.name).join(' & ')

    let out: GameState = {
      ...state,
      teams: nextTeams,
      dealerIndex: nextDealer,
      handNumber: state.handNumber + 1,
      phase: 'SETUP',
      trump: null,
      bidHistory: [],
      currentBidderIndex: (nextDealer + 1) % pc,
      bidWinnerIndex: null,
      bidWinnerTeamId: null,
      winningBid: null,
      discardPiles: emptyHands(pc),
      discardDone: Array.from({ length: pc }, () => false),
      mulliganUsed: Array.from({ length: pc }, () => false),
      hands7: emptyHands(pc),
      dealtHands7: emptyHands(pc),
      hands6: emptyHands(pc),
      currentPlayerIndex: nextDealer,
      trickNumber: 0,
      currentTrick: null,
      trickHistory: [],
      tricksWonByTeamId: maps.tricksWonByTeamId,
      cardsCapturedByTeamId: maps.cardsCapturedByTeamId,
      lastHandResult: null,
      winnerTeamId: null,
    }
    out = log(out, `${state.players[p].name} took the out. ${rosterName} is set for -2. Dealer rotates.`)
    return out
  }

if (action.type === 'PLACE_BID') {
    if (state.phase !== 'BIDDING') return state
    const pc = state.players.length
    const p = state.currentBidderIndex

    const priorHigh = currentHighBid(state.bidHistory)
    if (action.bid !== 'PASS') {
      if (!action.suit) return log(state, 'Bid requires a suit.')
      if (priorHigh && bidStrength(action.bid) <= bidStrength(priorHigh)) return log(state, 'Bid must strictly beat the current high bid.')
    }

    const nextHistory = state.bidHistory.concat([{ playerIndex: p, bid: action.bid, suit: action.suit }])
    const nextBidder = (p + 1) % pc
    const out: GameState = { ...state, bidHistory: nextHistory, currentBidderIndex: nextBidder, currentPlayerIndex: nextBidder }

    if (nextHistory.length >= pc) return resolveBidding(out)
    return out
  }

  if (action.type === 'DEALER_SET_TRUMP') {
    if (state.phase !== 'DEALER_TRUMP') return state
    if (state.dealerIndex !== state.currentPlayerIndex) return log(state, 'Only dealer can choose trump.')
    let out: GameState = {
      ...state,
      trump: action.suit,
      phase: 'DISCARD',
      hands7: (state.hands7.some(h => h.length) ? state.hands7 : state.dealtHands7),
      discardPiles: emptyHands(state.players.length),
      discardDone: Array.from({ length: state.players.length }, () => false),
      hands6: emptyHands(state.players.length),
      currentPlayerIndex: state.dealerIndex,
    }
    out = log(out, `Dealer chose trump: ${suitLabel[action.suit as Suit]}. Discard phase.`)
    return out
  }

  if (action.type === 'TOGGLE_DISCARD') {
    if (state.phase !== 'DISCARD') return state
    const baseHands7 = state.hands7.some(h => h.length) ? state.hands7 : state.dealtHands7
    const pi = action.playerIndex
    if (state.discardDone[pi]) return log(state, 'That player already confirmed discards.')

    const hands7 = baseHands7.map(h => h.slice())
    const discards = state.discardPiles.map(h => h.slice())

    if (inHand(hands7[pi], action.card)) {
      hands7[pi] = removeCard(hands7[pi], action.card)
      discards[pi] = addCard(discards[pi], action.card)
    } else if (inHand(discards[pi], action.card)) {
      discards[pi] = removeCard(discards[pi], action.card)
      hands7[pi] = addCard(hands7[pi], action.card)
    } else return state

    return { ...state, hands7, discardPiles: discards }
  }

  if (action.type === 'CONFIRM_DISCARD') {
    if (state.phase !== 'DISCARD') return state
    const pi = (action as any).playerIndex ?? state.currentPlayerIndex
    const done = state.discardDone.slice()
    done[pi] = true

    const next = done.every(Boolean) ? state.dealerIndex : state.currentPlayerIndex
    let out: GameState = { ...state, discardDone: done, currentPlayerIndex: next }
    out = log(out, `${state.players[pi].name} confirmed discards.`)
    if (done.every(Boolean)) out = log(out, 'All players confirmed. Dealer can redeal everyone to 6.')
    return out
  }

  if (action.type === 'REDEAL_TO_6') {
    if (state.phase !== 'DISCARD') return state
    if (!state.discardDone.every(Boolean)) return log(state, 'All players must confirm discards first.')
    if (state.currentPlayerIndex !== state.dealerIndex) return log(state, 'Only dealer can redeal.')

    const pc = state.players.length
    let hands6 = state.hands7.map(h => h.slice())
    let pos = state.deckPos

    for (let p = 0; p < pc; p++) {
      while (hands6[p].length < 6 && pos < state.deck.length) hands6[p].push(state.deck[pos++])
      if (hands6[p].length > 6) hands6[p] = hands6[p].slice(0, 6)
    }

    const leader = state.bidWinnerIndex ?? state.dealerIndex
    const trick: TrickState = { leaderIndex: leader, plays: [] }

    let out: GameState = { ...state, hands6, deckPos: pos, phase: 'PLAY', currentPlayerIndex: leader, trickNumber: 1, currentTrick: trick }
    out = log(out, 'Redeal complete. Play begins. Bid winner leads first trick.')
    return out
  }

  if (action.type === 'PLAY_CARD') {
    if (state.phase !== 'PLAY') return state
    const pi = state.currentPlayerIndex
    const hand = state.hands6[pi] ?? []
    if (!inHand(hand, action.card)) return log(state, 'That card is not in your hand.')

    const trump = state.trump
    if (!trump) return log(state, 'Trump not set.')

    const trick = state.currentTrick
    if (!trick) return state

    const leadSuit = trick.plays.length ? trick.plays[0].card.suit : null
    if (state.trickNumber === 1 && trick.plays.length === 0 && action.card.suit !== trump) return log(state, `First lead must be trump: ${suitLabel[trump]}.`)
	    // House rule: Trump is always allowed, even when you can follow the lead suit.
	    // Only enforce follow-suit when the played card is neither lead suit nor trump.
	    if (leadSuit && action.card.suit !== leadSuit && action.card.suit !== trump && canFollowSuit(hand, leadSuit)) {
	      return log(state, `Must follow suit: ${suitLabel[leadSuit]}.`)
	    }

    const hands6 = state.hands6.map(h => h.slice())
    hands6[pi] = removeCard(hands6[pi], action.card)

    const plays = trick.plays.concat([{ playerIndex: pi, card: action.card }])
    const pc = state.players.length

    let out: GameState = { ...state, hands6, currentTrick: { ...trick, plays } }
    out.currentPlayerIndex = (pi + 1) % pc

    if (plays.length === pc) {
      const winner = trickWinnerIndex(plays, trump)
      const winnerTeam = state.players[winner].teamId

      const statsByPlayerId = { ...out.statsByPlayerId }
      const wpid = state.players[winner].id
      const ws = statsByPlayerId[wpid] ?? { handsPlayed: 0, tricksWon: 0, stmAttempts: 0, stmSuccess: 0, stmFail: 0, bidsWon: 0, bidsMade: 0 }
      statsByPlayerId[wpid] = { ...ws, tricksWon: ws.tricksWon + 1 }
      out = { ...out, statsByPlayerId }

      const tricksWonByTeamId = { ...state.tricksWonByTeamId }
      tricksWonByTeamId[winnerTeam] = (tricksWonByTeamId[winnerTeam] ?? 0) + 1

      const cardsCapturedByTeamId = { ...state.cardsCapturedByTeamId }
      const captured = (cardsCapturedByTeamId[winnerTeam] ?? []).slice()
      for (const pl of plays) captured.push(pl.card)
      cardsCapturedByTeamId[winnerTeam] = captured

      const trickHistory = out.trickHistory.slice()
trickHistory.push({
  trickNumber: state.trickNumber,
  leaderIndex: trick.leaderIndex,
  winnerIndex: winner,
  plays,
})

out = { ...out, tricksWonByTeamId, cardsCapturedByTeamId, trickHistory }
out = log(out, `Trick ${state.trickNumber} won by ${state.players[winner].name}.`)

      const nextTrickNum = state.trickNumber + 1
      if (nextTrickNum > 6) {
        // scoring
        const result = computeHandResult(out)
        out = { ...out, phase: result.stmSucceeded ? 'GAME_END' : 'SCORE_HAND', currentTrick: null, lastHandResult: result }
        out = log(out, 'All 6 tricks completed. Scoring computed.')
        if (result.stmSucceeded) out = log(out, 'Shoot The Moon succeeded. Bidder team wins immediately.')
      } else {
        out = { ...out, trickNumber: nextTrickNum, currentPlayerIndex: winner, currentTrick: { leaderIndex: winner, plays: [] } }
        out = log(out, `Trick ${nextTrickNum}. ${state.players[winner].name} leads.`)
      }
    }

    return out
  }

  if (action.type === 'APPLY_SCORE_AND_NEXT_HAND') {
    if (state.phase !== 'SCORE_HAND') return state
    if (!state.lastHandResult) return state

    const applied = applyHandScoring(state, state.lastHandResult)

    const statsByPlayerId = { ...state.statsByPlayerId }
    for (const p of state.players) {
      const s = statsByPlayerId[p.id] ?? { handsPlayed: 0, tricksWon: 0, stmAttempts: 0, stmSuccess: 0, stmFail: 0, bidsWon: 0, bidsMade: 0 }
      statsByPlayerId[p.id] = { ...s, handsPlayed: s.handsPlayed + 1 }
    }
    if (state.lastHandResult.winningBid === 'STM') {
      const bidderId = state.players[state.lastHandResult.bidderPlayerIndex].id
      const bs = statsByPlayerId[bidderId] ?? { handsPlayed: 0, tricksWon: 0, stmAttempts: 0, stmSuccess: 0, stmFail: 0, bidsWon: 0, bidsMade: 0 }
      statsByPlayerId[bidderId] = {
        ...bs,
        stmAttempts: bs.stmAttempts + 1,
        stmSuccess: bs.stmSuccess + (state.lastHandResult.stmSucceeded ? 1 : 0),
        stmFail: bs.stmFail + (state.lastHandResult.stmFailed ? 1 : 0),
        bidsWon: bs.bidsWon + 1,
        bidsMade: bs.bidsMade + (state.lastHandResult.stmSucceeded ? 1 : 0),
      }
    } else {
      const bidderId = state.players[state.lastHandResult.bidderPlayerIndex].id
      const bs = statsByPlayerId[bidderId] ?? { handsPlayed: 0, tricksWon: 0, stmAttempts: 0, stmSuccess: 0, stmFail: 0, bidsWon: 0, bidsMade: 0 }
      statsByPlayerId[bidderId] = {
        ...bs,
        bidsWon: bs.bidsWon + 1,
        bidsMade: bs.bidsMade + (state.lastHandResult.bidderMadeBid ? 1 : 0),
      }
    }
    const pc = state.players.length
    const nextDealer = (state.dealerIndex + 1) % pc

    let out: GameState = { ...state, teams: applied.teams, dealerIndex: nextDealer, trump: null, bidHistory: [], phase: applied.winnerTeamId ? 'GAME_END' : 'SETUP', winnerTeamId: applied.winnerTeamId, statsByPlayerId }
    out = log(out, 'Score applied. Dealer rotates left.')
    if (applied.winnerTeamId) out = log(out, `Winner: ${applied.teams.find(t => t.id === applied.winnerTeamId)?.name ?? applied.winnerTeamId}`)
    return out
  }

  return state
}
