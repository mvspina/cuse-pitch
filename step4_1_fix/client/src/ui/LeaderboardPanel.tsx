import React from 'react'

export type LeaderboardRow = {
  name: string
  games: number
  wins: number
  losses: number
  winPct: number
}

export type LeaderboardPanelProps = {
  rows?: LeaderboardRow[]
  loading?: boolean
  error?: string | null
  onRefresh?: () => void
}

export default function LeaderboardPanel(props: LeaderboardPanelProps) {
  const { rows = [], loading = false, error = null, onRefresh } = props
  const hasRows = Array.isArray(rows) && rows.length > 0

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Leaderboard</h2>
        {onRefresh ? (
          <button type="button" className="btn small" onClick={onRefresh} disabled={loading}>
            {loading ? '…' : 'Refresh'}
          </button>
        ) : null}
      </div>
      <div className="small" style={{ color: 'rgba(255,255,255,0.65)', marginTop: 4 }}>
        Minimum 5 games to qualify. Ranked by Win% (ties by Games, then Wins).
      </div>
      {error ? (
        <div className="small" style={{ color: '#c00', marginTop: 8 }}>
          {error}
          {onRefresh ? (
            <button type="button" className="btn small" style={{ marginLeft: 8 }} onClick={onRefresh} disabled={loading}>
              Retry
            </button>
          ) : null}
        </div>
      ) : loading ? (
        <div className="small" style={{ marginTop: 8 }}>Loading…</div>
      ) : !hasRows ? (
        <div className="small" style={{ marginTop: 8 }}>No completed games yet.</div>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', minWidth: 200, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>Rank</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>Player</th>
                <th style={{ textAlign: 'right', padding: '4px 6px' }}>Games</th>
                <th style={{ textAlign: 'right', padding: '4px 6px' }}>Wins</th>
                <th style={{ textAlign: 'right', padding: '4px 6px' }}>Losses</th>
                <th style={{ textAlign: 'right', padding: '4px 6px' }}>Win%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td style={{ padding: '4px 6px' }}>{i + 1}</td>
                  <td style={{ padding: '4px 6px' }}>{row.name}</td>
                  <td style={{ textAlign: 'right', padding: '4px 6px' }}>{row.games}</td>
                  <td style={{ textAlign: 'right', padding: '4px 6px' }}>{row.wins}</td>
                  <td style={{ textAlign: 'right', padding: '4px 6px' }}>{row.losses}</td>
                  <td style={{ textAlign: 'right', padding: '4px 6px' }}>{(row.winPct * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
