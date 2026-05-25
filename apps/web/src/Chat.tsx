import React, { useState, useEffect, useRef } from 'react'
import { useStream, archiveEntity } from '@electric-graphiti/core'
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
  const [confirmArchive, setConfirmArchive] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, agentRunning])

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [input])

  function submit() {
    if (!input.trim() || agentRunning) return
    send(input)
    setInput('')
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    submit()
  }

  async function handleArchive() {
    await archiveEntity(agentsUrl, entityType, entityId)
    onBack()
  }

  return (
    <div className="chat">
      <header>
        <button onClick={onBack} className="back">←</button>
        <span className="session-path">/{entityType}/{entityId}</span>
        <span className="status">{status}</span>
        {confirmArchive ? (
          <span className="archive-confirm">
            sure?
            <button onClick={handleArchive}>yes</button>
            <button onClick={() => setConfirmArchive(false)}>no</button>
          </span>
        ) : (
          <button onClick={() => setConfirmArchive(true)} className="archive">archive</button>
        )}
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
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onTouchEnd={() => textareaRef.current?.focus()}
          placeholder="type a message…"
          rows={1}
        />
        <button type="submit" disabled={!input.trim() || agentRunning}>send</button>
      </form>
    </div>
  )
}
