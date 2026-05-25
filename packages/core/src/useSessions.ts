import { useState, useEffect } from 'react'
import type { EntityInfo } from './types.js'
import { listEntities, spawnEntity as apiSpawnEntity, archiveEntity as apiArchiveEntity } from './api.js'

export function useSessions(agentsUrl: string, entityType: string) {
  const [entities, setEntities] = useState<EntityInfo[]>([])

  useEffect(() => {
    listEntities(agentsUrl, entityType)
      .then(list =>
        setEntities(
          list.filter(e => e.status !== 'killed').sort((a, b) => b.updated_at - a.updated_at)
        )
      )
      .catch(() => {})
  }, [agentsUrl, entityType])

  async function spawn(entityId: string): Promise<void> {
    await apiSpawnEntity(agentsUrl, entityType, entityId)
  }

  async function archive(entityId: string): Promise<void> {
    setEntities(prev => prev.filter(e => e.url.split('/').pop() !== encodeURIComponent(entityId)))
    await apiArchiveEntity(agentsUrl, entityType, entityId)
  }

  return { entities, spawn, archive }
}
