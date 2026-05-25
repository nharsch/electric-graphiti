import type { EntityInfo } from './types.js'

export function makeUrls(agentsUrl: string, entityType: string, entityId: string) {
  const encodedId = encodeURIComponent(entityId)
  const path = `/${entityType}/${encodedId}`
  return {
    entityPath: `/${entityType}/${entityId}`,
    streamUrl: `${agentsUrl}${path}/main`,
    sendUrl: `${agentsUrl}/_electric/entities${path}/send`,
  }
}

export async function sendMessage(sendUrl: string, text: string): Promise<void> {
  await fetch(sendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: { text } }),
  })
}

export async function spawnEntity(
  agentsUrl: string,
  entityType: string,
  entityId: string
): Promise<void> {
  await fetch(
    `${agentsUrl}/_electric/entities/${entityType}/${encodeURIComponent(entityId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }
  )
}

export async function listEntities(
  agentsUrl: string,
  entityType: string
): Promise<EntityInfo[]> {
  const r = await fetch(`${agentsUrl}/_electric/entities?type=${entityType}`)
  if (!r.ok) return []
  return r.json()
}
