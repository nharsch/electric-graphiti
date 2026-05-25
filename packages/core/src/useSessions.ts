import { useState, useEffect } from 'react'
import type { EntityInfo } from './types.js'
import { listEntities, spawnEntity as apiSpawnEntity } from './api.js'

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

  async function spawn(entityId: string, name?: string): Promise<void> {
    await apiSpawnEntity(agentsUrl, entityType, entityId, name ? { name } : undefined)
  }

  return { entities, spawn }
}
