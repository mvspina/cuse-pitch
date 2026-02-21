export type Suit = 'S' | 'H' | 'D' | 'C'
export type Rank = '2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'10'|'J'|'Q'|'K'|'A'
export type Card = { suit: Suit, rank: Rank }

export type BidKind = 2 | 3 | 4 | 'STM' | 'PASS'

export type GameSettings = {
  targetScore: 11 | 21
  playerCount: 2 | 3 | 4 | 6
}

export type Player = { id: string, name: string, teamId: string }
export type Team = { id: string, name: string, score: number }

export type Phase =
  | 'SETUP'
  | 'BIDDING'
  | 'DEALER_TRUMP'
  | 'DISCARD'
  | 'PLAY'
  | 'SCORE_HAND'
  | 'GAME_END'

export type BidEntry = { playerIndex: number, bid: BidKind, suit?: Suit }

export type TrickPlay = { playerIndex: number, card: Card }
export type TrickState = { leaderIndex: number, plays: TrickPlay[] }

export type TrickComplete = {
  trickNumber: number
  leaderIndex: number
  winnerIndex: number
  plays: TrickPlay[]
}
export type PlayerStats = {
  handsPlayed: number
  tricksWon: number
  stmAttempts: number
  stmSuccess: number
  stmFail: number
}

export type Category = 'HIGH' | 'LOW' | 'JACK' | 'GAME'

export type TeamHandScore = {
  teamId: string
  categoriesWon: Category[]
  categoryPoints: number
  gamePoints: number
  totalHandPoints: number
}

export type HandResult = {
  bidderTeamId: string
  bidderPlayerIndex: number
  winningBid: Exclude<BidKind,'PASS'>
  trump: Suit
  // For STM
  stmSucceeded: boolean
  stmFailed: boolean
  stmPenalty: number // 0 if not applied
  // For normal bid
  bidderMadeBid: boolean
  bidderSetPenalty: number // 0 if not set
  teamScores: TeamHandScore[]
  notes: string[]
}

export type GameState = {
  settings: GameSettings
  players: Player[]
  teams: Team[]
  dealerIndex: number
  handNumber: number
  phase: Phase

  deck: Card[]
  deckPos: number
  hands7: Card[][]
  dealtHands7: Card[][]

  trump: Suit | null
  bidHistory: BidEntry[]
  currentBidderIndex: number
  bidWinnerIndex: number | null
  bidWinnerTeamId: string | null
  winningBid: Exclude<BidKind,'PASS'> | null

  discardPiles: Card[][]
  discardDone: boolean[]
  mulliganUsed: boolean[]
  hands6: Card[][]

  currentPlayerIndex: number
  trickNumber: number
  currentTrick: TrickState | null
  trickHistory: TrickComplete[]
  tricksWonByTeamId: Record<string, number>
  cardsCapturedByTeamId: Record<string, Card[]>

  lastHandResult: HandResult | null
  winnerTeamId: string | null

  handId?: string

  messageLog: string[]
  statsByPlayerId: Record<string, PlayerStats>
}

export type Action =
  | Mulligan7Action

  | { type: 'NEW_GAME', settings: GameSettings, names?: string[] }
  | { type: 'SET_TARGET', targetScore: 11 | 21 }
  | { type: 'SET_PLAYERCOUNT', playerCount: 2 | 3 | 4 | 6 }
  | { type: 'SET_NAME', playerIndex: number, name: string }
  | { type: 'START_HAND' }
  | { type: 'PLACE_BID', bid: BidKind, suit?: Suit }
  | { type: 'TAKE_OUT' }
  | { type: 'DEALER_SET_TRUMP', suit: Suit }
  | { type: 'TOGGLE_DISCARD', playerIndex: number, card: Card }
  | { type: 'CONFIRM_DISCARD' }
  | { type: 'REDEAL_TO_6' }
  | { type: 'PLAY_CARD', card: Card }
  | { type: 'APPLY_SCORE_AND_NEXT_HAND' }
