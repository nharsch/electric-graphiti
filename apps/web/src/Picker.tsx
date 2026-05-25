import React, { useState, useRef } from 'react'
import { useSessions } from '@electric-graphiti/core'
import { randomUUID } from './utils.js'
import type { EntityInfo } from '@electric-graphiti/core'

type Props = {
  agentsUrl: string
  entityType: string
  onSelect: (id: string) => void
}

export function Picker({ agentsUrl, entityType, onSelect }: Props) {
  const { entities, spawn } = useSessions(agentsUrl, entityType)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function startNaming() {
    setNaming(true)
    setName('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function create() {
    const id = randomUUID()
    spawn(id, name.trim() || undefined).catch(() => {})
    setNaming(false)
    setName('')
    onSelect(id)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') create()
    if (e.key === 'Escape') { setNaming(false); setName('') }
  }

  const statusDot = (s: string) =>
    s === 'idle' ? '🟢' : s === 'running' ? '🟡' : '⚫'

  return (
    <div className="picker">
      <h1>electric-graphiti</h1>
      <ul>
        {entities.map((e: EntityInfo) => {
          const id = decodeURIComponent(e.url.split('/').pop()!)
          const ago = Math.round((Date.now() - e.updated_at) / 60000)
          const label = e.tags.name || id
          return (
            <li key={e.url}>
              <button onClick={() => onSelect(id)}>
                <span>{statusDot(e.status)}</span>
                <span className="session-id">{label}</span>
                <span className="session-meta">
                  {e.status} · {ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`}
                </span>
              </button>
            </li>
          )
        })}
        <li>
          {naming ? (
            <div className="new-session-form">
              <input
                ref={inputRef}
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="session name (optional)"
              />
              <button onClick={create}>create</button>
              <button onClick={() => { setNaming(false); setName('') }} className="cancel">✕</button>
            </div>
          ) : (
            <button onClick={startNaming} className="new-session">
              + New session
            </button>
          )}
        </li>
      </ul>
    </div>
  )
}
