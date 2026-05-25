import React, { useState, useEffect } from 'react'
import { Picker } from './Picker.js'
import { Chat } from './Chat.js'

const AGENTS_URL = ''  // proxied through Vite dev server; empty = same origin
const ENTITY_TYPE = 'assistant'

export function App() {
  const [entityId, setEntityId] = useState<string | null>(null)

  useEffect(() => {
    // Prevent the virtual keyboard from resizing the viewport on Android Chrome,
    // which causes layout reflow that drops textarea focus.
    if ('virtualKeyboard' in navigator) {
      (navigator as any).virtualKeyboard.overlaysContent = true
    }
  }, [])

  if (!entityId) {
    return <Picker agentsUrl={AGENTS_URL} entityType={ENTITY_TYPE} onSelect={setEntityId} />
  }

  return <Chat agentsUrl={AGENTS_URL} entityType={ENTITY_TYPE} entityId={entityId} onBack={() => setEntityId(null)} />
}
