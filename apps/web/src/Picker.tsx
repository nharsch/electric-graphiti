import React from 'react'
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

  function handleNew() {
    const id = randomUUID()
    spawn(id).catch(() => {})
    onSelect(id)
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
          return (
            <li key={e.url}>
              <button onClick={() => onSelect(id)}>
                <span>{statusDot(e.status)}</span>
                <span className="session-id">{id}</span>
                <span className="session-meta">
                  {e.status} · {ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`}
                </span>
              </button>
            </li>
          )
        })}
        <li>
          <button onClick={handleNew} className="new-session">
            + New session
          </button>
        </li>
      </ul>
    </div>
  )
}
