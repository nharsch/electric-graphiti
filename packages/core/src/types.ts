export type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export type StreamEvent = {
  type: string
  key: string
  value: Record<string, unknown>
  headers: { operation: string; offset: string }
}

export type EntityInfo = {
  url: string
  status: string
  updated_at: number
  tags: Record<string, string>
}
