import React, { useState } from 'react'
import { render, Box, Text, useStdout, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { randomUUID } from 'node:crypto'
import { useStream, useSessions } from '@electric-graphiti/core'
import type { EntityInfo } from '@electric-graphiti/core'

const AGENTS_URL = process.env.ELECTRIC_AGENTS_URL ?? 'http://localhost:4437'
const ENTITY_TYPE = process.env.ENTITY_TYPE ?? 'assistant'
const CLI_ENTITY_ID = process.argv[2] ?? process.env.ENTITY_ID ?? null

function Chat({ entityId }: { entityId: string }) {
  const { stdout } = useStdout()
  const { messages, status, agentRunning, send } = useStream(AGENTS_URL, ENTITY_TYPE, entityId)
  const [input, setInput] = useState('')

  const entityPath = `/${ENTITY_TYPE}/${entityId}`
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
            send(val)
          }}
          placeholder="type a message..."
        />
      </Box>
    </Box>
  )
}

function Picker({ onSelect }: { onSelect: (id: string) => void }) {
  const { entities, spawn } = useSessions(AGENTS_URL, ENTITY_TYPE)
  const [cursor, setCursor] = useState(0)

  const items = [...entities.map(e => decodeURIComponent(e.url.split('/').pop()!)), '__new__']

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setCursor(c => Math.max(0, c - 1))
    if (key.downArrow || input === 'j') setCursor(c => Math.min(items.length - 1, c + 1))
    if (key.return) {
      const selected = items[cursor]
      if (selected === '__new__') {
        const id = randomUUID().slice(0, 8)
        spawn(id).then(() => onSelect(id))
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
        {entities.map((e: EntityInfo, i: number) => {
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
