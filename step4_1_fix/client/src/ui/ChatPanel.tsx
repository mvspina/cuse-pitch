import React, { useState, useCallback, useRef, useEffect } from 'react'

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

const MAX_LENGTH = 200

const messageStyle = {
  animation: 'chatFadeIn 0.18s ease-out',
}

export default function ChatPanel(props: ChatPanelProps) {
  const { messages = [], onSend, disabled = false, title = 'Table Chat', loading = false, error = null } = props
  const [input, setInput] = useState('')
  const hasMessages = Array.isArray(messages) && messages.length > 0

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const shouldStickToBottomRef = useRef(true)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    shouldStickToBottomRef.current = isNearBottom
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (shouldStickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages.length])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const send = useCallback(() => {
    const trimmed = input.trim()
    if (disabled || !trimmed || !onSend) return
    const toSend = trimmed.slice(0, MAX_LENGTH)
    onSend(toSend)
    setInput('')
    inputRef.current?.focus()
  }, [input, disabled, onSend])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <>
      <style>{`
@keyframes chatFadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
`}</style>
    <div className="card">
      <h2 style={{ margin: 0 }}>{title}</h2>
      {loading && (
        <div className="small" style={{ marginTop: 8, color: 'rgba(255,255,255,0.7)' }}>Loading…</div>
      )}
      {error && (
        <div className="small" style={{ marginTop: 8, color: '#f88' }}>{error}</div>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          maxHeight: 200,
          overflowY: 'auto',
          marginTop: 8,
          background: '#f3f4f6',
          borderRadius: 10,
          padding: 8,
        }}
      >
        {!hasMessages ? (
          <div className="small" style={{ padding: '8px 12px', color: '#6b7280' }}>
            No messages yet.
          </div>
        ) : (
          (() => {
            const grouped: { name: string; userId?: number | null; items: ChatMessage[] }[] = []
            for (const msg of messages) {
              const last = grouped[grouped.length - 1]
              if (last && last.name === msg.name && msg.name !== 'System') {
                last.items.push(msg)
              } else {
                grouped.push({ name: msg.name, userId: (msg as ChatMessage & { userId?: number | null }).userId, items: [msg] })
              }
            }
            return (
              <div style={{ padding: '0 4px' }}>
                {grouped.map((group, gi) => {
                  const isSystem = group.name === 'System'
                  const isSelf = group.name === 'You'

                  if (isSystem) {
                    return (
                      <div
                        key={gi}
                        style={{
                          ...messageStyle,
                          textAlign: 'center',
                          fontSize: 12,
                          color: '#666',
                          fontStyle: 'italic',
                          padding: '6px 0',
                        }}
                      >
                        {group.items[0].text}
                      </div>
                    )
                  }

                  return (
                    <div key={gi} style={{ marginBottom: 8, ...messageStyle }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 12,
                          color: isSelf ? '#2563eb' : '#333',
                          marginBottom: 2,
                        }}
                      >
                        {group.name}
                      </div>
                      <div
                        style={{
                          background: isSelf ? 'rgba(37,99,235,0.12)' : 'rgba(0,0,0,0.06)',
                          borderRadius: 8,
                          padding: '6px 8px',
                          display: 'inline-block',
                          maxWidth: '100%',
                        }}
                      >
                        {group.items.map((m, i) => (
                          <div
                            key={m.id}
                            style={{
                              lineHeight: 1.35,
                              wordBreak: 'break-word' as const,
                              ...(i > 0 ? { marginTop: 4 } : {}),
                            }}
                          >
                            {m.text}
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })()
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <input
          ref={inputRef}
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
    </>
  )
}
