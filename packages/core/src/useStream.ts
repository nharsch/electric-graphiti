import { useState, useEffect, useRef } from 'react'
import type { Message, StreamEvent } from './types.js'
import { makeUrls, sendMessage as apiSendMessage } from './api.js'
import { reconstructMessages, applyEvents } from './messages.js'

export type StreamStatus = 'connecting' | 'waiting' | 'connected' | string

export function useStream(agentsUrl: string, entityType: string, entityId: string) {
  const { streamUrl, sendUrl } = makeUrls(agentsUrl, entityType, entityId)

  const [messages, setMessages] = useState<Message[]>([])
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [agentRunning, setAgentRunning] = useState(false)

  const nextOffsetRef = useRef<string>('0')
  const textBuffersRef = useRef<Map<string, string[]>>(new Map())
  const messagesRef = useRef<Message[]>([])

  useEffect(() => {
    let cancelled = false
    let abortController: AbortController | null = null

    async function loadAndConnect() {
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
        if (attempts === 1) setStatus('waiting')
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
          setStatus(`error: ${err}`)
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

  async function send(text: string) {
    if (!text.trim()) return
    await apiSendMessage(sendUrl, text)
  }

  return { messages, status, agentRunning, send }
}
