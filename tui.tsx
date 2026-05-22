import React, { useState, useEffect, useRef } from 'react'
import { render, Box, Text, useApp, useStdout, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { randomUUID } from 'node:crypto'

const AGENTS_URL = process.env.ELECTRIC_AGENTS_URL ?? 'http://localhost:4437'
const ENTITY_TYPE = process.env.ENTITY_TYPE ?? 'assistant'

// Entity ID from CLI arg, env, or will be prompted
const CLI_ENTITY_ID = process.argv[2] ?? process.env.ENTITY_ID ?? null

function makeUrls(entityId: string) {
  const encodedId = encodeURIComponent(entityId)
  const path = `/${ENTITY_TYPE}/${encodedId}`
  return {
    entityPath: `/${ENTITY_TYPE}/${entityId}`,
    streamUrl: `${AGENTS_URL}${path}/main`,
    sendUrl: `${AGENTS_URL}/_electric/entities${path}/send`,
  }
}

type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

type StreamEvent = {
  type: string
  key: string
  value: Record<string, unknown>
  headers: { operation: string; offset: string }
}

function reconstructMessages(events: StreamEvent[]): {
  messages: Message[]
  nextOffset: string
  running: boolean
} {
  const messages: Message[] = []
  const textBuffers = new Map<string, string[]>()
  let running = false
  let lastOffset = '0'

  for (const e of events) {
    lastOffset = e.headers.offset
    const v = e.value as any

    if (e.type === 'inbox' && e.headers.operation === 'insert') {
      const text = v?.payload?.text
      if (text) messages.push({ id: e.key, role: 'user', text })
    } else if (e.type === 'text_delta') {
      const tid = v?.text_id as string
      if (tid) {
        if (!textBuffers.has(tid)) textBuffers.set(tid, [])
        textBuffers.get(tid)!.push(v?.delta ?? '')
      }
    } else if (e.type === 'text' && e.headers.operation === 'update' && v?.status === 'completed') {
      const buf = textBuffers.get(e.key)
      if (buf && !messages.find(m => m.id === e.key)) {
        messages.push({ id: e.key, role: 'assistant', text: buf.join('') })
        textBuffers.delete(e.key)
      }
    } else if (e.type === 'run') {
      running = v?.status === 'started'
    }
  }

  return { messages, nextOffset: lastOffset, running }
}

function applyEvents(
  messages: Message[],
  textBuffers: Map<string, string[]>,
  events: StreamEvent[]
): { messages: Message[]; running: boolean } {
  let running = false

  for (const e of events) {
    const v = e.value as any

    if (e.type === 'inbox' && e.headers.operation === 'insert') {
      const text = v?.payload?.text
      if (text) messages.push({ id: e.key, role: 'user', text })
    } else if (e.type === 'text_delta') {
      const tid = v?.text_id as string
      if (tid) {
        if (!textBuffers.has(tid)) textBuffers.set(tid, [])
        textBuffers.get(tid)!.push(v?.delta ?? '')
      }
    } else if (e.type === 'text' && e.headers.operation === 'update' && v?.status === 'completed') {
      const buf = textBuffers.get(e.key)
      if (buf && !messages.find(m => m.id === e.key)) {
        messages.push({ id: e.key, role: 'assistant', text: buf.join('') })
        textBuffers.delete(e.key)
      }
    } else if (e.type === 'run') {
      running = v?.status === 'started'
    }
  }

  return { messages, running }
}

function Chat({ entityId }: { entityId: string }) {
  const { stdout } = useStdout()
  const { entityPath, streamUrl, sendUrl } = makeUrls(entityId)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('connecting...')
  const [agentRunning, setAgentRunning] = useState(false)

  const nextOffsetRef = useRef<string>('0')
  const textBuffersRef = useRef<Map<string, string[]>>(new Map())
  const messagesRef = useRef<Message[]>([])

  useEffect(() => {
    let cancelled = false
    let abortController: AbortController | null = null

    async function loadAndConnect() {
      // Poll until stream exists (new entities take a moment to initialize)
      let attempts = 0
      while (!cancelled) {
        try {
          const res = await fetch(`${streamUrl}?offset=-1`)
          if (res.ok) {
            const events: StreamEvent[] = await res.json()
            if (cancelled) return
            const { messages: hist, nextOffset, running } = reconstructMessages(events)
            messagesRef.current = hist
            nextOffsetRef.current = nextOffset
            setMessages([...hist])
            setAgentRunning(running)
            setStatus('connected')
            tailSSE()
            return
          }
        } catch {}
        attempts++
        if (attempts === 1) setStatus('waiting for stream...')
        await new Promise(r => setTimeout(r, 800))
      }
    }

    async function tailSSE() {
      if (cancelled) return
      abortController = new AbortController()

      try {
        const res = await fetch(
          `${streamUrl}?offset=${nextOffsetRef.current}&live=sse`,
          { signal: abortController.signal }
        )
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let buf = ''

        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })

          const parts = buf.split('\n\n')
          buf = parts.pop() ?? ''

          for (const part of parts) {
            const lines = part.split('\n')
            const eventLine = lines.find(l => l.startsWith('event:'))
            const dataLine = lines.find(l => l.startsWith('data:'))
            if (!eventLine || !dataLine) continue

            const eventType = eventLine.slice(6).trim()
            const data = dataLine.slice(5).trim()

            if (eventType === 'control') {
              const ctrl = JSON.parse(data)
              nextOffsetRef.current = ctrl.streamNextOffset
            } else if (eventType === 'data') {
              const events: StreamEvent[] = JSON.parse(data)
              const msgs = [...messagesRef.current]
              const { messages: updated, running } = applyEvents(msgs, textBuffersRef.current, events)
              messagesRef.current = updated
              setMessages([...updated])
              setAgentRunning(running)
            }
          }
        }
      } catch (err: any) {
        if (!cancelled && err?.name !== 'AbortError') {
          setStatus(`sse error: ${err}`)
        }
      }

      if (!cancelled) setTimeout(tailSSE, 1000)
    }

    loadAndConnect()
    return () => {
      cancelled = true
      abortController?.abort()
    }
  }, [streamUrl])

  async function sendMessage(text: string) {
    if (!text.trim()) return
    await fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { text } }),
    })
  }

  const termHeight = stdout?.rows ?? 24
  const visibleRows = termHeight - 7
  const visibleMessages = messages.slice(-Math.max(visibleRows, 5))

  return (
    <Box flexDirection="column" height={termHeight}>
      <Box borderStyle="single" paddingX={1}>
        <Text bold color="cyan">electric-graphiti</Text>
        <Text color="gray"> — {entityPath}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
        {visibleMessages.map((msg) => (
          <Box key={msg.id} flexDirection="column" marginBottom={1}>
            <Text bold color={msg.role === 'user' ? 'green' : 'blue'}>
              {msg.role === 'user' ? 'you' : 'assistant'}
            </Text>
            <Text wrap="wrap">{msg.text}</Text>
          </Box>
        ))}
        {agentRunning && (
          <Box>
            <Text color="yellow">● thinking...</Text>
          </Box>
        )}
      </Box>

      <Box paddingX={1}>
        <Text color="gray" dimColor>{status}</Text>
      </Box>

      <Box borderStyle="single" paddingX={1}>
        <Text color="green">&gt; </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={(val) => {
            setInput('')
            sendMessage(val)
          }}
          placeholder="type a message..."
        />
      </Box>
    </Box>
  )
}

type EntityInfo = { url: string; status: string; updated_at: number }

async function spawnEntity(entityId: string): Promise<void> {
  await fetch(`${AGENTS_URL}/_electric/entities/${ENTITY_TYPE}/${encodeURIComponent(entityId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}

function Picker({ onSelect }: { onSelect: (id: string) => void }) {
  const [entities, setEntities] = useState<EntityInfo[]>([])
  const [cursor, setCursor] = useState(0)

  useEffect(() => {
    fetch(`${AGENTS_URL}/_electric/entities?type=${ENTITY_TYPE}`)
      .then(r => r.json())
      .then((list: EntityInfo[]) => setEntities(list.sort((a, b) => b.updated_at - a.updated_at)))
      .catch(() => {})
  }, [])

  // items = existing entities + "New session" sentinel
  const items = [...entities.map(e => decodeURIComponent(e.url.split('/').pop()!)), '__new__']

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setCursor(c => Math.max(0, c - 1))
    if (key.downArrow || input === 'j') setCursor(c => Math.min(items.length - 1, c + 1))
    if (key.return) {
      const selected = items[cursor]
      if (selected === '__new__') {
        const id = randomUUID().slice(0, 8)
        spawnEntity(id).then(() => onSelect(id))
      } else {
        onSelect(selected)
      }
    }
  })

  const statusColor = (s: string) =>
    s === 'idle' ? 'green' : s === 'running' ? 'yellow' : 'gray'


  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Text bold color="cyan">electric-graphiti</Text>
      <Text color="gray" dimColor>↑↓ navigate · Enter select</Text>
      <Box flexDirection="column">
        {entities.map((e, i) => {
          const id = decodeURIComponent(e.url.split('/').pop()!)
          const ago = Math.round((Date.now() - e.updated_at) / 60000)
          const selected = cursor === i
          return (
            <Box key={e.url} gap={2}>
              <Text color="cyan">{selected ? '›' : ' '}</Text>
              <Text color={statusColor(e.status)}>●</Text>
              <Text bold={selected}>{id}</Text>
              <Text color="gray" dimColor>
                {e.status} · {ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`}
              </Text>
            </Box>
          )
        })}
        <Box gap={2}>
          <Text color="cyan">{cursor === items.length - 1 ? '›' : ' '}</Text>
          <Text color="gray">+</Text>
          <Text bold={cursor === items.length - 1} color="gray">New session...</Text>
        </Box>
      </Box>
    </Box>
  )
}

function App() {
  const [entityId, setEntityId] = useState<string | null>(CLI_ENTITY_ID)

  if (!entityId) {
    return <Picker onSelect={setEntityId} />
  }

  return <Chat entityId={entityId} />
}

render(<App />)
