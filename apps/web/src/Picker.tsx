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
  const { entities, spawn, archive } = useSessions(agentsUrl, entityType)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function startNaming() {
    setNaming(true)
    setName('')
    setError('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function cancel() {
    setNaming(false)
    setName('')
    setError('')
  }

  function create() {
    const trimmed = name.trim()
    const id = trimmed || randomUUID()

    if (trimmed) {
      const taken = entities.some(
        e => decodeURIComponent(e.url.split('/').pop()!) === trimmed
      )
      if (taken) {
        setError(`"${trimmed}" is already taken`)
        return
      }
    }

    spawn(id).catch(() => {})
    cancel()
    onSelect(id)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') create()
    if (e.key === 'Escape') cancel()
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
            <li key={e.url} className="session-row">
              <button onClick={() => onSelect(id)}>
                <span>{statusDot(e.status)}</span>
                <span className="session-id">{label}</span>
                <span className="session-meta">
                  {e.status} · {ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`}
                </span>
              </button>
              <button className="archive-btn" onClick={() => archive(id)} title="Archive">×</button>
            </li>
          )
        })}
        <li>
          {naming ? (
            <div className="new-session-form">
              <input
                ref={inputRef}
                value={name}
                onChange={e => { setName(e.target.value); setError('') }}
                onKeyDown={handleKeyDown}
                placeholder="session name (optional)"
              />
              <button onClick={create}>create</button>
              <button onClick={cancel} className="cancel">✕</button>
            </div>
          ) : (
            <button onClick={startNaming} className="new-session">
              + New session
            </button>
          )}
          {error && <p className="name-error">{error}</p>}
        </li>
      </ul>
    </div>
  )
}
