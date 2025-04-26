export type TokenCounts = {
  input: number
  input_cache_hit?: number
  output: number
}

type UserMessage = {
  role: "user"
  content: string
  image_url?: string
  cache?: boolean
}

type AssistantMessage = {
  role: "assistant"
  model: string
  content: string
  tokens: TokenCounts
  stop_reason: string
  cost: number
  timeMs: number
  cache?: boolean
}

export type ChatMessage = UserMessage | AssistantMessage

export type Chat = {
  // For now we don't allow system prompt to be changed in the middle
  // of a chat. Otherwise we'd have to annotate each message with it.
  systemPrompt: string
  messages: ChatMessage[]
  createdAt: Date
  summary?: string
}
