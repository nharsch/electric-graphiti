import type { Message, StreamEvent } from './types.js'

export function reconstructMessages(events: StreamEvent[]): {
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

export function applyEvents(
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
