import React, { useState, useEffect, useRef } from 'react'
import { useStream } from '@electric-graphiti/core'
import type { Message } from '@electric-graphiti/core'

type Props = {
  agentsUrl: string
  entityType: string
  entityId: string
  onBack: () => void
}

export function Chat({ agentsUrl, entityType, entityId, onBack }: Props) {
  const { messages, status, agentRunning, send } = useStream(agentsUrl, entityType, entityId)
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, agentRunning])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!input.trim()) return
    send(input)
    setInput('')
  }

  return (
    <div className="chat">
      <header>
        <button onClick={onBack} className="back">←</button>
        <span className="session-path">/{entityType}/{entityId}</span>
        <span className="status">{status}</span>
      </header>

      <div className="messages">
        {messages.map((msg: Message) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <span className="role">{msg.role === 'user' ? 'you' : 'assistant'}</span>
            <p>{msg.text}</p>
          </div>
        ))}
        {agentRunning && (
          <div className="message assistant thinking">
            <span className="role">assistant</span>
            <p>thinking…</p>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="input-row">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="type a message…"
          autoFocus
        />
        <button type="submit" disabled={!input.trim() || agentRunning}>send</button>
      </form>
    </div>
  )
}
