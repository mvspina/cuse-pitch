import React, { useState, useCallback } from 'react'

export type ChatMessage = {
  id: string
  ts: number
  name: string
  text: string
}

export type ChatPanelProps = {
  messages?: ChatMessage[]
  onSend?: (text: string) => void
  disabled?: boolean
  title?: string
  loading?: boolean
  error?: string | null
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const h = d.getHours()
  const m = d.getMinutes()
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

const MAX_LENGTH = 200

export default function ChatPanel(props: ChatPanelProps) {
  const { messages = [], onSend, disabled = false, title = 'Table Chat', loading = false, error = null } = props
  const [input, setInput] = useState('')
  const hasMessages = Array.isArray(messages) && messages.length > 0

  const send = useCallback(() => {
    const trimmed = input.trim()
    if (disabled || !trimmed || !onSend) return
    const toSend = trimmed.slice(0, MAX_LENGTH)
    onSend(toSend)
    setInput('')
  }, [input, disabled, onSend])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="card">
      <h2 style={{ margin: 0 }}>{title}</h2>
      {loading && (
        <div className="small" style={{ marginTop: 8, color: 'rgba(255,255,255,0.7)' }}>Loading…</div>
      )}
      {error && (
        <div className="small" style={{ marginTop: 8, color: '#f88' }}>{error}</div>
      )}
      <div
        style={{
          maxHeight: 200,
          overflowY: 'auto',
          marginTop: 8,
          padding: '8px 0',
          border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: 4,
          background: 'rgba(0,0,0,0.15)',
        }}
      >
        {!hasMessages ? (
          <div className="small" style={{ padding: '8px 12px', color: 'rgba(255,255,255,0.7)' }}>
            No messages yet.
          </div>
        ) : (
          <div style={{ padding: '0 12px' }}>
            {messages.map((msg) => (
              <div key={msg.id} style={{ marginBottom: 8 }}>
                <span className="small" style={{ color: 'rgba(255,255,255,0.75)' }}>
                  {formatTime(msg.ts)} <strong>{msg.name}</strong>:
                </span>
                <div className="small" style={{ marginLeft: 4, marginTop: 2, wordBreak: 'break-word' }}>
                  {msg.text}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <input
          type="text"
          className="small"
          value={input}
          onChange={(e) => setInput(e.target.value.slice(0, MAX_LENGTH))}
          onKeyDown={handleKeyDown}
          placeholder="Type a message…"
          disabled={disabled}
          style={{ flex: 1, minWidth: 0, padding: '6px 10px' }}
          maxLength={MAX_LENGTH}
        />
        <button type="button" className="btn small" onClick={send} disabled={disabled || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  )
}
