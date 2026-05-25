import React, { useState, useEffect } from 'react'
import { Picker } from './Picker.js'
import { Chat } from './Chat.js'

const AGENTS_URL = ''
const ENTITY_TYPE = 'assistant'

function parseHash(): string | null {
  const m = window.location.hash.match(/^#\/[^/]+\/([^/]+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

export function App() {
  const [entityId, setEntityId] = useState<string | null>(parseHash)

  useEffect(() => {
    if ('virtualKeyboard' in navigator) {
      (navigator as any).virtualKeyboard.overlaysContent = true
    }
  }, [])

  useEffect(() => {
    function onHashChange() {
      setEntityId(parseHash())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  function navigate(id: string) {
    window.location.hash = `/${ENTITY_TYPE}/${encodeURIComponent(id)}`
  }

  function goBack() {
    window.history.back()
  }

  if (!entityId) {
    return <Picker agentsUrl={AGENTS_URL} entityType={ENTITY_TYPE} onSelect={navigate} />
  }

  return <Chat agentsUrl={AGENTS_URL} entityType={ENTITY_TYPE} entityId={entityId} onBack={goBack} />
}
